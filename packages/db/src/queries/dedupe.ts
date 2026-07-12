/**
 * Dedupe-stage queries (issue #106, Epic #6) — the sanctioned write/read
 * paths for `signal_versions` and `suspected_duplicates`, plus the pgvector
 * candidate query the fuzzy path runs. Kept in `packages/db` so the worker
 * never writes inline SQL (the same rule as the normalize stage's helpers).
 *
 * Semantics live with the stage (`workers/pipeline/src/stages/dedupe.ts`);
 * this module is mechanics: version append + pointer move, canonical-pair
 * suspected-duplicate inserts (idempotent by the unique pair index), and an
 * ANN query shaped for the HNSW index's happy path.
 */

import type { Actor, SuspectedDuplicateResolution } from "@wellregarded/core";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { audit, type Tx } from "../audit.js";
import type { Db } from "../client.js";
import { signalVersions, suspectedDuplicates } from "../schema/dedupe.js";
import { importRuns } from "../schema/importRuns.js";
import { signals } from "../schema/signals.js";
import type { Signal } from "./signals.js";

/** A `signal_versions` row. */
export type SignalVersion = typeof signalVersions.$inferSelect;

/** A `suspected_duplicates` row. */
export type SuspectedDuplicate = typeof suspectedDuplicates.$inferSelect;

/**
 * A signal with its CURRENT content resolved: the latest recorded version's
 * text/rating when `current_version_id` is set, the immutable originals
 * otherwise. The dedupe stage compares incoming re-imports against this —
 * an edit-of-an-edit must diff against the latest version, not the original.
 */
export interface SignalWithCurrentContent {
  signal: Signal;
  currentText: string | null;
  /** numeric(2,1) — arrives from postgres-js as a string, e.g. `"4.0"`. */
  currentRating: string | null;
}

/** Fetch a signal plus resolved current content; `undefined` if no row. */
export async function getSignalWithCurrentContent(
  db: Db | Tx,
  signalId: string,
): Promise<SignalWithCurrentContent | undefined> {
  const rows = await db
    .select({
      signal: signals,
      versionContent: signalVersions.content,
      versionRating: signalVersions.rating,
    })
    .from(signals)
    .leftJoin(signalVersions, eq(signalVersions.id, signals.currentVersionId))
    .where(eq(signals.id, signalId))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  const hasVersion = row.signal.currentVersionId !== null;
  return {
    signal: row.signal,
    currentText: hasVersion ? row.versionContent : row.signal.originalText,
    currentRating: hasVersion ? row.versionRating : row.signal.originalRating,
  };
}

export interface RecordSignalVersionInput {
  signalId: string;
  /** The re-imported content (null for rating-only edits). */
  content: string | null;
  /** Canonicalized rating string (same representation as `original_rating`). */
  rating: string | null;
  /** Source-reported edit time, when the adapter carries one. */
  sourceUpdatedAt: Date | null;
  /**
   * Embedding of the NEW content, when the caller could compute one; null
   * clears the stored embedding — a stale vector describing superseded text
   * must not keep matching fuzzy candidates.
   */
  embedding: number[] | null;
}

/**
 * The exact path's update policy (#106): append a `signal_versions` row and
 * move the signal's `current_version_id` pointer, leaving `original_text` /
 * `original_rating` untouched (the `signals_protect_original` trigger
 * enforces that they stay untouched). Also advances `pipeline_status` to
 * `pending_classify` — the caller re-enqueues classify so derivations
 * refresh. Call inside the stage's transaction with the import-run count
 * update so the `merged` tally commits atomically with the version row.
 */
export async function recordSignalVersion(
  tx: Db | Tx,
  input: RecordSignalVersionInput,
): Promise<SignalVersion> {
  const [version] = await tx
    .insert(signalVersions)
    .values({
      signalId: input.signalId,
      content: input.content,
      rating: input.rating,
      sourceUpdatedAt: input.sourceUpdatedAt,
    })
    .returning();
  if (!version) throw new Error("recordSignalVersion: insert returned no row");
  await tx
    .update(signals)
    .set({
      currentVersionId: version.id,
      embedding: input.embedding,
      pipelineStatus: "pending_classify",
      updatedAt: sql`now()`,
    })
    .where(eq(signals.id, input.signalId));
  return version;
}

/**
 * Store a signal's embedding on first computation (#106 requirement 8), so
 * classify and future coverage work reuse it instead of re-embedding.
 */
export async function updateSignalEmbedding(
  db: Db | Tx,
  signalId: string,
  embedding: number[],
): Promise<void> {
  await db
    .update(signals)
    .set({ embedding, updatedAt: sql`now()` })
    .where(eq(signals.id, signalId));
}

/** Advance a signal's position in the pipeline spine. */
export async function setSignalPipelineStatus(
  db: Db | Tx,
  signalId: string,
  status: Signal["pipelineStatus"],
): Promise<void> {
  await db
    .update(signals)
    .set({ pipelineStatus: status, updatedAt: sql`now()` })
    .where(eq(signals.id, signalId));
}

export interface FindDuplicateCandidatesParams {
  practiceId: string;
  /** The signal being deduped — excluded from its own candidate set. */
  excludeSignalId: string;
  /** Embedding of the signal's text (bge-m3 / 1024 dims). */
  embedding: number[];
  /** Center of the `occurred_at` window. */
  occurredAt: Date;
  /** Symmetric window half-width in days. */
  windowDays: number;
  /** ANN candidate-pool size. */
  limit: number;
}

/**
 * One fuzzy-duplicate candidate: cosine similarity plus the fields the
 * stage's in-code predicates (same rating, cross-source) need. `rating` is
 * the candidate's CURRENT rating (latest version wins over original).
 */
export interface DuplicateCandidate {
  id: string;
  /** 1 - cosine distance; 1 = identical direction. */
  similarity: number;
  rating: string | null;
  sourceKind: Signal["sourceKind"];
  sourceId: string | null;
}

/**
 * The ANN candidate query (#106 implementation note): vector order + the
 * cheap same-row predicates (practice, window, not-self, has-embedding) in
 * SQL — the HNSW index's happy path — with the rating/source predicates and
 * the similarity threshold applied in code by the stage.
 *
 * Never interpolate the embedding into SQL text — it binds as a parameter
 * in pgvector's string format and casts (same rule as `hybridSearch`).
 */
export async function findDuplicateCandidates(
  db: Db | Tx,
  params: FindDuplicateCandidatesParams,
): Promise<DuplicateCandidate[]> {
  const embeddingParam = `[${params.embedding.join(",")}]`;
  const windowMs = params.windowDays * 24 * 60 * 60 * 1000;
  // Bound as ISO strings + ::timestamptz casts: raw-SQL params bypass the
  // column-type mapping, and postgres-js only serializes primitives there.
  const from = new Date(params.occurredAt.getTime() - windowMs).toISOString();
  const to = new Date(params.occurredAt.getTime() + windowMs).toISOString();

  const result = await db.execute(sql`
    SELECT s.id,
           (1 - (s.embedding <=> ${embeddingParam}::vector))::float8 AS similarity,
           COALESCE(sv.rating, s.original_rating)::text AS rating,
           s.source_kind,
           s.source_id
    FROM signals s
    LEFT JOIN signal_versions sv ON sv.id = s.current_version_id
    WHERE s.practice_id = ${params.practiceId}
      AND s.id <> ${params.excludeSignalId}
      AND s.embedding IS NOT NULL
      AND s.occurred_at BETWEEN ${from}::timestamptz AND ${to}::timestamptz
    ORDER BY s.embedding <=> ${embeddingParam}::vector
    LIMIT ${params.limit}
  `);

  // postgres-js returns the row array directly; other drizzle drivers
  // return a pg-style `{ rows }` object (same normalization as hybridSearch).
  const rows: unknown[] = Array.isArray(result)
    ? result
    : ((result as unknown as { rows: unknown[] }).rows ?? []);

  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      similarity: r.similarity as number,
      rating: (r.rating as string | null) ?? null,
      sourceKind: r.source_kind as Signal["sourceKind"],
      sourceId: (r.source_id as string | null) ?? null,
    };
  });
}

/**
 * Canonical pair ordering for `suspected_duplicates`: the lexicographically
 * smaller UUID is always `signalIdA`, so a symmetric re-detection maps to
 * the same row (unique index + CHECK constraint enforce it at the database).
 */
export function canonicalPair(
  signalIdX: string,
  signalIdY: string,
): { signalIdA: string; signalIdB: string } {
  return signalIdX < signalIdY
    ? { signalIdA: signalIdX, signalIdB: signalIdY }
    : { signalIdA: signalIdY, signalIdB: signalIdX };
}

export interface SuspectedDuplicateLink {
  practiceId: string;
  signalIdX: string;
  signalIdY: string;
  similarity: number;
}

/**
 * Record suspected-duplicate links for human review — NEVER a merge. Pairs
 * are canonicalized here (defense in depth; the table CHECKs it) and insert
 * with `ON CONFLICT DO NOTHING`, so redelivery and symmetric detection are
 * idempotent. Returns the number of rows actually inserted — the caller
 * adds exactly that to the run's `suspected_duplicates` stat, in the same
 * transaction, so counts can never drift from rows.
 */
export async function insertSuspectedDuplicates(
  tx: Db | Tx,
  links: SuspectedDuplicateLink[],
): Promise<number> {
  if (links.length === 0) return 0;
  const inserted = await tx
    .insert(suspectedDuplicates)
    .values(
      links.map((link) => ({
        practiceId: link.practiceId,
        ...canonicalPair(link.signalIdX, link.signalIdY),
        similarity: link.similarity,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: suspectedDuplicates.id });
  return inserted.length;
}

/** Pending-review links for a signal (either side) — the inbox's read. */
export async function listSuspectedDuplicatesForPractice(
  db: Db | Tx,
  practiceId: string,
  status: SuspectedDuplicate["status"] = "pending_review",
): Promise<SuspectedDuplicate[]> {
  return db
    .select()
    .from(suspectedDuplicates)
    .where(
      and(
        eq(suspectedDuplicates.practiceId, practiceId),
        eq(suspectedDuplicates.status, status),
      ),
    )
    .orderBy(suspectedDuplicates.createdAt);
}

/** One side of a per-run suspected-duplicate link (report page preview). */
export interface ImportRunDuplicateSignal {
  id: string;
  sourceKind: Signal["sourceKind"];
  visibility: Signal["visibility"];
  occurredAt: Date;
  /** Original text — a preview snippet, not the resolved current content. */
  text: string | null;
  /** True when this side was ingested by the run being reported on. */
  fromThisRun: boolean;
}

export interface ImportRunDuplicate {
  link: SuspectedDuplicate;
  a: ImportRunDuplicateSignal;
  b: ImportRunDuplicateSignal;
}

/**
 * Suspected-duplicate links touching an import run — every pair where at
 * least one side was ingested by the run (issue #137). Read-only
 * visibility for the report page: resolution happens on the signal detail
 * (issue #90), which these previews link to. Newest first, bounded — a
 * run that trips more than `limit` links should send the user to the
 * inbox's duplicates filter rather than render an endless report section.
 */
export async function listSuspectedDuplicatesForImportRun(
  db: Db | Tx,
  practiceId: string,
  importRunId: string,
  limit = 50,
): Promise<ImportRunDuplicate[]> {
  const a = alias(signals, "dup_signal_a");
  const b = alias(signals, "dup_signal_b");
  const rows = await db
    .select({ link: suspectedDuplicates, a, b })
    .from(suspectedDuplicates)
    .innerJoin(a, eq(a.id, suspectedDuplicates.signalIdA))
    .innerJoin(b, eq(b.id, suspectedDuplicates.signalIdB))
    .where(
      and(
        eq(suspectedDuplicates.practiceId, practiceId),
        or(eq(a.importRunId, importRunId), eq(b.importRunId, importRunId)),
      ),
    )
    .orderBy(desc(suspectedDuplicates.createdAt))
    .limit(limit);

  const preview = (
    signal: typeof a.$inferSelect,
  ): ImportRunDuplicateSignal => ({
    id: signal.id,
    sourceKind: signal.sourceKind,
    visibility: signal.visibility,
    occurredAt: signal.occurredAt,
    text: signal.originalText,
    fromThisRun: signal.importRunId === importRunId,
  });

  return rows.map((row) => ({
    link: row.link,
    a: preview(row.a),
    b: preview(row.b),
  }));
}

export interface ResolveSuspectedDuplicateInput {
  practiceId: string;
  /** The `suspected_duplicates` row id. */
  duplicateId: string;
  resolution: SuspectedDuplicateResolution;
  /** Who resolved it — audited in the same transaction. */
  actor: Actor;
}

/**
 * Resolve a pending suspected-duplicate link (issue #90): `same` →
 * `confirmed`, `different` → `dismissed`; the status change and its
 * audit row commit in one transaction. Only `pending_review` rows resolve —
 * an already-resolved (or cross-practice, or unknown) id returns
 * `undefined`, so double submits are harmless.
 *
 * Deliberately NOT a merge. The epic's hard rule is no silent merges: both
 * raws are kept and both details stay reachable; `confirmed` records the
 * human's verdict that they describe the same event. Canonical semantics
 * (#93) are derived, not stored: the OLDER signal of a confirmed pair
 * (earliest occurred_at, then created_at, then id) is canonical, and
 * `listSignals` hides the non-canonical member from default listings
 * (visible via the duplicate filter).
 */
export async function resolveSuspectedDuplicate(
  db: Db,
  input: ResolveSuspectedDuplicateInput,
): Promise<SuspectedDuplicate | undefined> {
  const status = input.resolution === "same" ? "confirmed" : "dismissed";
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(suspectedDuplicates)
      .set({ status })
      .where(
        and(
          eq(suspectedDuplicates.id, input.duplicateId),
          eq(suspectedDuplicates.practiceId, input.practiceId),
          eq(suspectedDuplicates.status, "pending_review"),
        ),
      )
      .returning();
    if (!row) return undefined;
    await audit(tx, {
      practiceId: input.practiceId,
      actor: input.actor,
      action: `suspected_duplicate.${status}`,
      entityType: "suspected_duplicates",
      entityId: row.id,
      payload: {
        resolution: input.resolution,
        signalIdA: row.signalIdA,
        signalIdB: row.signalIdB,
        similarity: row.similarity,
      },
    });
    return row;
  });
}

/**
 * Import-run artifact keys (#100/#111): the raw artifacts a run stored,
 * which the exact path re-reads to compare incoming content against the
 * stored signal. Returns `undefined` when the run does not exist.
 */
export async function getImportRunArtifactKeys(
  db: Db | Tx,
  importRunId: string,
): Promise<string[] | undefined> {
  const rows = await db
    .select({ rawArtifactKeys: importRuns.rawArtifactKeys })
    .from(importRuns)
    .where(eq(importRuns.id, importRunId))
    .limit(1);
  return rows[0]?.rawArtifactKeys;
}
