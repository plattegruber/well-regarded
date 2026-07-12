/**
 * Reply-import backfill core (issue #214, Epic #10) — the resumable,
 * batched loop behind the `wr-reply-import-backfill` Workflow, kept free
 * of `cloudflare:workers` imports so it runs under plain Node in tests
 * (the embedding-backfill pattern, #71).
 *
 * Why it exists: the normalize stage now persists a Google review's
 * pre-existing owner reply (`sourceMetadata.existingReply`, #125) as an
 * imported `responses` row — but reviews ingested BEFORE that seam landed
 * only have the reply in their immutable raw artifact (#100). This job
 * re-reads those artifacts and routes each observed reply through the
 * same sanctioned write path (`upsertImportedResponse`), so a backfilled
 * row is indistinguishable from a normalize-written one.
 *
 * Shape:
 *
 * - **Keyset cursor over `signals`** (`googleSignalsForReplyImport`,
 *   id-ordered `afterId` batches) — Google-only, since no other source
 *   reports existing replies. The scan deliberately re-visits signals
 *   that already have an imported response: the upsert reports those as
 *   `unchanged` (or `updated`, when the reply was edited at the source),
 *   so re-running the whole backfill is always safe.
 * - **One R2 read per distinct artifact per batch**: review-page
 *   envelopes hold many reviews, and their signal rows share the
 *   artifact key and sort adjacently (uuid batches may still split a
 *   page — the worst case is one extra read, never a wrong result).
 * - **Skip, count, continue**: a missing artifact or one the adapter can
 *   no longer normalize must not wedge the backfill — its signals are
 *   skipped and reported (`artifactsMissing`/`artifactsFailed`), and the
 *   keyset cursor guarantees forward progress past them.
 * - **One transaction per reply write** (`upsertImportedResponse` + its
 *   audit row, actor `system jobs:reply-import-backfill`), never one per
 *   batch: a mid-batch crash re-runs the batch, and the upsert makes the
 *   replayed writes no-ops.
 */

import {
  type Db,
  googleSignalsForReplyImport,
  type ReplyImportCandidate,
  upsertImportedResponse,
} from "@wellregarded/db";
import {
  ArtifactNotFoundError,
  getRawArtifact,
  googleReviewsAdapter,
  type NormalizedSignal,
  type RawArtifactBucket,
} from "@wellregarded/sources";

/** Workflow parameters — everything optional, defaults below. */
export interface ReplyImportBackfillParams {
  /** Scope to one practice; null/absent sweeps globally. */
  practiceId?: string | null;
  /** Signal rows per batch (= per Workflow step). Default 100. */
  batchSize?: number;
  /** Pause between batches (R2 + Postgres are cheap; keep it short). */
  sleepMs?: number;
}

export const DEFAULT_REPLY_IMPORT_BATCH_SIZE = 100;
export const DEFAULT_REPLY_IMPORT_SLEEP_MS = 1000;

export interface ResolvedReplyImportParams {
  practiceId: string | undefined;
  batchSize: number;
  sleepMs: number;
}

/** Apply defaults; tolerate a missing/partial payload. */
export function resolveReplyImportParams(
  params: ReplyImportBackfillParams | undefined,
): ResolvedReplyImportParams {
  return {
    practiceId: params?.practiceId ?? undefined,
    batchSize: params?.batchSize ?? DEFAULT_REPLY_IMPORT_BATCH_SIZE,
    sleepMs: params?.sleepMs ?? DEFAULT_REPLY_IMPORT_SLEEP_MS,
  };
}

/** The counters one batch reports back to the orchestration loop. */
export interface ReplyImportCounts {
  /** Signal rows scanned. */
  scanned: number;
  /** Scanned rows whose artifact carries an existing reply for them. */
  withReply: number;
  /** New imported `responses` rows. */
  imported: number;
  /** Existing imported rows refreshed (reply edited at the source). */
  updated: number;
  /** Existing imported rows already byte-identical (idempotent re-run). */
  unchanged: number;
  /** Distinct artifacts no longer present in R2 (rows skipped). */
  artifactsMissing: number;
  /** Distinct artifacts the adapter could not normalize (rows skipped). */
  artifactsFailed: number;
}

/** What one batch reports back — plain JSON data (a step checkpoint). */
export interface ReplyImportBatchResult extends ReplyImportCounts {
  /** Keyset cursor for the next batch; null when the batch was empty. */
  lastId: string | null;
  /** True when this batch drained the remaining rows. */
  done: boolean;
}

function emptyCounts(): ReplyImportCounts {
  return {
    scanned: 0,
    withReply: 0,
    imported: 0,
    updated: 0,
    unchanged: 0,
    artifactsMissing: 0,
    artifactsFailed: 0,
  };
}

/** Audit actor for every backfill write. */
export const REPLY_IMPORT_ACTOR = {
  type: "system",
  id: "jobs:reply-import-backfill",
} as const;

/**
 * One batch: scan the next id-ordered slice of Google signals, re-read
 * their raw artifacts (once per distinct key), re-normalize through the
 * registered adapter, and upsert an imported response for every review
 * that carries an existing reply. Runs inside a `step.do`, so a thrown
 * error here is retried by the Workflows engine without re-running
 * earlier batches; everything the batch writes is idempotent.
 */
export async function importRepliesBatch(
  db: Db,
  bucket: RawArtifactBucket,
  opts: {
    practiceId?: string | undefined;
    afterId?: string | undefined;
    batchSize: number;
  },
): Promise<ReplyImportBatchResult> {
  const rows = await googleSignalsForReplyImport(db, {
    practiceId: opts.practiceId,
    afterId: opts.afterId,
    limit: opts.batchSize,
  });
  const counts = emptyCounts();
  if (rows.length === 0) {
    return { ...counts, lastId: null, done: true };
  }
  counts.scanned = rows.length;

  const normalizedByArtifact = await normalizeBatchArtifacts(
    bucket,
    rows,
    counts,
  );

  for (const row of rows) {
    const normalized = normalizedByArtifact
      .get(row.rawArtifactKey)
      ?.get(row.sourceId);
    const reply = normalized?.sourceMetadata?.existingReply;
    if (reply === undefined) continue;
    counts.withReply += 1;
    // One transaction per write: the responses row and its audit entry
    // commit atomically (the same contract the normalize seam gets from
    // its per-artifact transaction).
    const { outcome } = await db.transaction((tx) =>
      upsertImportedResponse(tx, {
        practiceId: row.practiceId,
        signalId: row.id,
        body: reply.comment,
        publishedAt:
          reply.updateTime !== undefined ? new Date(reply.updateTime) : null,
        publishUpdateTime: reply.updateTime ?? null,
        moderationState: reply.state ?? null,
        policyViolation: reply.policyViolation ?? null,
        actor: REPLY_IMPORT_ACTOR,
        auditPayload: { backfill: true, rawArtifactKey: row.rawArtifactKey },
      }),
    );
    if (outcome === "created") counts.imported += 1;
    else if (outcome === "updated") counts.updated += 1;
    else counts.unchanged += 1;
  }

  const lastId = rows[rows.length - 1]?.id ?? null;
  return { ...counts, lastId, done: rows.length < opts.batchSize };
}

/**
 * Load + re-normalize each distinct artifact in the batch, mapping
 * `rawArtifactKey → (sourceId → NormalizedSignal)`. Missing/unparseable
 * artifacts are counted and omitted — their signals fall through the
 * reply lookup and are skipped, never retried forever (see module doc).
 */
async function normalizeBatchArtifacts(
  bucket: RawArtifactBucket,
  rows: readonly ReplyImportCandidate[],
  counts: ReplyImportCounts,
): Promise<Map<string, Map<string, NormalizedSignal>>> {
  const byArtifact = new Map<string, Map<string, NormalizedSignal>>();
  for (const key of new Set(rows.map((row) => row.rawArtifactKey))) {
    let artifact: unknown;
    try {
      artifact = await getRawArtifact(bucket, key);
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) {
        counts.artifactsMissing += 1;
        continue;
      }
      // Anything else (R2 hiccup, corrupted read) might be transient —
      // throw so the Workflows engine retries the batch.
      throw error;
    }
    try {
      const normalized = await googleReviewsAdapter.normalize(artifact);
      byArtifact.set(
        key,
        new Map(
          normalized
            .filter((signal) => signal.sourceId !== null)
            .map((signal) => [signal.sourceId as string, signal]),
        ),
      );
    } catch {
      // The artifact is immutable: if the adapter rejects these bytes now
      // it always will. Count and move on — parity with the normalize
      // stage's non-retryable posture, minus the DLQ (there is no message).
      counts.artifactsFailed += 1;
    }
  }
  return byArtifact;
}

/**
 * Structural subset of the Workflows `WorkflowStep` the loop uses —
 * deliberately non-generic (only `ReplyImportBatchResult`, plain JSON,
 * flows through a step). Same seam as the embedding backfill (#71).
 */
export interface ReplyImportStep {
  do(
    name: string,
    callback: () => Promise<ReplyImportBatchResult>,
  ): Promise<ReplyImportBatchResult>;
  sleep(name: string, durationMs: number): Promise<void>;
}

export interface ReplyImportBackfillDeps {
  /**
   * One batch of real work, given the cursor. The Workflow wires this to
   * `importRepliesBatch` over a per-step DB connection; tests fake it.
   */
  processBatch(afterId: string | null): Promise<ReplyImportBatchResult>;
}

/** The run's report: totals across every batch. */
export interface ReplyImportBackfillSummary extends ReplyImportCounts {
  batches: number;
}

/**
 * The orchestration loop: one `step.do` per batch (durable checkpoint),
 * `step.sleep` between batches, keyset cursor threaded through step
 * return values so a resumed run continues where it stopped. Step names
 * are deterministic (`import-replies-batch-<n>`) — the engine keys its
 * checkpoint cache by name, which is what makes replay skip completed
 * batches.
 */
export async function runReplyImportBackfill(
  step: ReplyImportStep,
  deps: ReplyImportBackfillDeps,
  params: ResolvedReplyImportParams,
): Promise<ReplyImportBackfillSummary> {
  const summary: ReplyImportBackfillSummary = { ...emptyCounts(), batches: 0 };
  let afterId: string | null = null;
  for (let batchIndex = 0; ; batchIndex++) {
    const cursor = afterId;
    const result: ReplyImportBatchResult = await step.do(
      `import-replies-batch-${batchIndex}`,
      () => deps.processBatch(cursor),
    );
    summary.scanned += result.scanned;
    summary.withReply += result.withReply;
    summary.imported += result.imported;
    summary.updated += result.updated;
    summary.unchanged += result.unchanged;
    summary.artifactsMissing += result.artifactsMissing;
    summary.artifactsFailed += result.artifactsFailed;
    if (result.scanned > 0) summary.batches += 1;
    if (result.done || result.lastId === null) {
      return summary;
    }
    afterId = result.lastId;
    await step.sleep(`pause-after-batch-${batchIndex}`, params.sleepMs);
  }
}
