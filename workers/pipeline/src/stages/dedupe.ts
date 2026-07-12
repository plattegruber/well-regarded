/**
 * Dedupe stage — consumer of `wr-dedupe` (issue #106, Epic #6).
 *
 * Decides what a signal that already has a `signals` row IS: an update, a
 * cross-source duplicate candidate, or genuinely new — under the epic's one
 * hard rule: **no silent merges**. There is no code path here that merges,
 * hides, or drops a signal; the strongest action this stage ever takes is
 * linking two signals for a HUMAN to review in the Signals inbox (Epic #11).
 *
 * Two paths, split by the message's `reason`:
 *
 * **Exact** (`reason: "conflict_reimport"` from normalize #104 — the insert
 * hit the `(practice_id, source_kind, source_id)` unique constraint, so the
 * same source identity came around again):
 * 1. Re-read the incoming artifact from R2 (the run's `raw_artifact_keys`),
 *    re-normalize, find the entry with this signal's `source_id`.
 * 2. Compare content hashes — sha256 over (text, rating, occurred_at) — of
 *    the incoming version vs the signal's CURRENT content (latest
 *    `signal_versions` row if one exists, the immutable originals
 *    otherwise).
 * 3. Unchanged → `import_runs.skipped` + 1, stop; nothing downstream.
 * 4. Changed (an edited review) → the update policy: `original_text` /
 *    `original_rating` stay untouched (the `signals_protect_original`
 *    trigger enforces it), the new content is APPENDED as a
 *    `signal_versions` row, the signal's `current_version_id` pointer
 *    moves, `merged` + 1, the event is audit-logged, and classify is
 *    re-enqueued so derivations refresh against the new text. (Note:
 *    re-delivery after a crash re-compares against the now-current version,
 *    hashes equal, and lands on the skipped path — naturally idempotent.)
 *
 * **Fuzzy** (no `reason` — a NEW signal): find cross-source duplicate
 * CANDIDATES in the same practice — `occurred_at` within ±N days, same
 * rating, embedding cosine similarity above threshold, different source
 * identity (constants in `@wellregarded/core`; predicates in ./dedupe/
 * candidates.ts) — and record a `suspected_duplicates` link per hit
 * (`pending_review`, counted into the run's stats). The new signal then
 * proceeds to classify NORMALLY: both records stay fully visible.
 *
 * Embeddings come through the `EmbeddingProvider` seam in
 * `@wellregarded/ai` (this stage uses the single-text `embedText` shape).
 * The production implementation is Workers AI `@cf/baai/bge-m3` behind
 * the `AI` binding (issue #71, Epic #9) — bound in preview/prod; the
 * local wrangler block deliberately omits it (no local simulator, and the
 * workerd unit-test pool boots from that block), so locally the fuzzy
 * path is SKIPPED with a structured log line — never a fake vector, never
 * a merge. Tests inject the deterministic `FakeEmbeddingProvider`. A
 * computed embedding is stored on the signal (requirement 8) so classify
 * and coverage reuse it.
 *
 * Persistence hides behind the `DedupeStore` seam (the normalize/classify
 * pattern): workerd tests drive the real dispatcher with an in-memory
 * store; the Node integration suite drives the real store against
 * Postgres + pgvector. All count updates commit transactionally with the
 * row writes they describe (#111 helpers).
 */

import {
  createWorkersAiEmbedder,
  type EmbeddingProvider,
} from "@wellregarded/ai";
import {
  type ClassifyMessage,
  createLogger,
  type DedupeMessage,
  FUZZY_DUPLICATE_CANDIDATE_LIMIT,
  FUZZY_DUPLICATE_SIMILARITY_THRESHOLD,
  FUZZY_DUPLICATE_WINDOW_DAYS,
  fallbackRequestId,
  NonRetryableError,
  RetryableError,
} from "@wellregarded/core";
import {
  audit,
  createDb,
  type Db,
  type DuplicateCandidate,
  findDuplicateCandidates,
  getImportRunArtifactKeys,
  getSignalWithCurrentContent,
  incrementImportRunCounts,
  insertSuspectedDuplicates,
  recordSignalVersion,
  type SignalWithCurrentContent,
  type SuspectedDuplicateLink,
  setSignalPipelineStatus,
  updateSignalEmbedding,
} from "@wellregarded/db";
import {
  ArtifactNotFoundError,
  getAdapter,
  getRawArtifact,
  type NormalizedSignal,
} from "@wellregarded/sources";

import type { PipelineBindings } from "../bindings";
import { hasEmbeddableText, isSuspectedDuplicate } from "./dedupe/candidates";
import { contentHash } from "./dedupe/contentHash";
import { canonicalizeRating } from "./normalize/rating";
import type { StageHandler } from "./types";

/** The incoming re-import's content, as the exact path compares it. */
export interface IncomingVersion {
  text: string | null;
  /** Canonical `numeric(2,1)` string — same representation as the column. */
  rating: string | null;
  occurredAt: Date;
  /** Source-reported edit time; null until an adapter carries one. */
  sourceUpdatedAt: Date | null;
}

/**
 * The stage's narrow persistence seam. Production is `createDedupeStore`
 * over the Hyperdrive-backed client; workerd tests inject an in-memory
 * fake (no Postgres inside the test pool).
 */
export interface DedupeStore {
  getSignal(signalId: string): Promise<SignalWithCurrentContent | undefined>;
  /** The run's stored raw-artifact keys; `undefined` if the run is gone. */
  getImportRunArtifactKeys(importRunId: string): Promise<string[] | undefined>;
  /** Unchanged re-import: `skipped` + 1. */
  recordUnchangedReimport(message: DedupeMessage): Promise<void>;
  /**
   * Edited re-import, one transaction: append the `signal_versions` row,
   * move the current-content pointer, `merged` + 1, audit-log the event.
   */
  recordEditedReimport(
    message: DedupeMessage,
    incoming: IncomingVersion,
    embedding: number[] | null,
  ): Promise<void>;
  /** Store the embedding on first computation (requirement 8). */
  saveEmbedding(signalId: string, embedding: number[]): Promise<void>;
  findCandidates(params: {
    practiceId: string;
    excludeSignalId: string;
    embedding: number[];
    occurredAt: Date;
  }): Promise<DuplicateCandidate[]>;
  /**
   * Suspected links + the run's `suspected_duplicates` stat, one
   * transaction; only NEWLY inserted links count (idempotent redelivery).
   * Returns how many links were actually new.
   */
  recordSuspectedDuplicates(
    message: DedupeMessage,
    links: SuspectedDuplicateLink[],
  ): Promise<number>;
  /** Advance `pipeline_status` to `pending_classify` before the enqueue. */
  markReadyForClassify(signalId: string): Promise<void>;
}

export interface DedupeDeps {
  store: DedupeStore;
  /**
   * Absent until issue #71 wires Workers AI bge-m3: the fuzzy path is
   * skipped with a structured log line (exact-path updates still work, and
   * no embedding means no suspected links — never a fake vector).
   */
  embedder?: EmbeddingProvider | undefined;
}

function log(
  level: "info" | "warn",
  event: string,
  message: DedupeMessage,
  extra?: object,
): void {
  // The dispatcher guarantees a requestId on delivered messages (issue
  // #64); the fallback only fires for direct test invocations.
  createLogger({
    worker: "pipeline",
    requestId: message.requestId ?? fallbackRequestId(),
    practiceId: message.practiceId,
    stage: "dedupe",
  })[level](event, {
    signalId: message.signalId,
    importRunId: message.importRunId,
    ...extra,
  });
}

/**
 * The stage logic with its dependencies injected — what every test drives.
 * Throws per the dispatcher's failure vocabulary (see ./types.ts).
 */
export async function dedupeSignal(
  message: DedupeMessage,
  env: PipelineBindings,
  deps: DedupeDeps,
): Promise<void> {
  const record = await deps.store.getSignal(message.signalId);
  if (!record) {
    // The row is gone (or never existed): no retry can conjure it back.
    throw new NonRetryableError(
      `dedupe: signal ${message.signalId} does not exist`,
    );
  }

  if (message.reason === "conflict_reimport") {
    const proceed = await handleExactReimport(message, env, deps, record);
    if (!proceed) return; // unchanged/skipped: nothing downstream.
  } else {
    await handleFuzzyCandidates(message, deps, record);
  }

  await deps.store.markReadyForClassify(message.signalId);
  await env.CLASSIFY_QUEUE.send({
    signalId: message.signalId,
    practiceId: message.practiceId,
    importRunId: message.importRunId,
    // Producers copy the trace id forward (issue #64).
    requestId: message.requestId,
  } satisfies ClassifyMessage);
}

/**
 * The exact path. Returns `true` when the signal should proceed to
 * classify (content changed → derivations must refresh), `false` when the
 * re-import was a no-op (skipped; nothing downstream).
 */
async function handleExactReimport(
  message: DedupeMessage,
  env: PipelineBindings,
  deps: DedupeDeps,
  record: SignalWithCurrentContent,
): Promise<boolean> {
  const { signal } = record;

  if (signal.retentionState !== "active") {
    // Redacted/purged content was nulled by design (Epic #23). Recording a
    // re-imported version would resurrect content compliance removed —
    // skip, and leave the run a trace.
    await deps.store.recordUnchangedReimport(message);
    log("warn", "pipeline.dedupe.reimport_skipped_retention", message, {
      retentionState: signal.retentionState,
    });
    return false;
  }

  const incoming = await loadIncomingVersion(message, env, deps, record);
  const [incomingHash, storedHash] = await Promise.all([
    contentHash({
      text: incoming.text,
      rating: incoming.rating,
      occurredAt: incoming.occurredAt,
    }),
    contentHash({
      text: record.currentText,
      rating: record.currentRating,
      occurredAt: signal.occurredAt,
    }),
  ]);

  if (incomingHash === storedHash) {
    await deps.store.recordUnchangedReimport(message);
    log("info", "pipeline.dedupe.reimport_unchanged", message);
    return false;
  }

  // Changed content (an edited review): append-only version + pointer move
  // — the update policy. The original columns are never touched, so the
  // signals_protect_original trigger stays silent. Re-embed the NEW text
  // when a provider is available; otherwise the stored embedding is
  // cleared (a stale vector must not keep matching the old text).
  const embedding =
    deps.embedder && hasEmbeddableText(incoming.text)
      ? await deps.embedder.embedText(incoming.text)
      : null;
  await deps.store.recordEditedReimport(message, incoming, embedding);
  log("info", "pipeline.dedupe.version_recorded", message);
  return true;
}

/**
 * Re-read the incoming artifact(s) of THIS import run and find the entry
 * carrying the stored signal's source identity. Misses are contract
 * violations (store-before-enqueue #100; runs record their keys #111) —
 * non-retryable, so they land on the DLQ and in the run's error samples
 * instead of retry-looping.
 */
async function loadIncomingVersion(
  message: DedupeMessage,
  env: PipelineBindings,
  deps: DedupeDeps,
  record: SignalWithCurrentContent,
): Promise<IncomingVersion> {
  const { signal } = record;
  const keys = await deps.store.getImportRunArtifactKeys(message.importRunId);
  if (keys === undefined) {
    throw new NonRetryableError(
      `dedupe: import run ${message.importRunId} does not exist`,
    );
  }
  if (keys.length === 0) {
    throw new NonRetryableError(
      `dedupe: import run ${message.importRunId} recorded no raw artifact ` +
        "keys — cannot compare the re-imported content (#111 contract)",
    );
  }

  const adapter = getAdapter(signal.sourceKind);
  if (adapter === undefined) {
    throw new NonRetryableError(
      `dedupe: no SourceAdapter registered for sourceKind "${signal.sourceKind}"`,
    );
  }

  for (const key of keys) {
    let artifact: unknown;
    try {
      artifact = await getRawArtifact(env.RAW_ARTIFACTS, key);
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) {
        throw new NonRetryableError(error.message);
      }
      throw error; // R2 hiccup: let the dispatcher retry.
    }
    // No re-validation: these exact bytes already passed normalize's strict
    // schema — that is how the conflict message got enqueued at all.
    let entries: NormalizedSignal[];
    try {
      entries = await adapter.normalize(artifact);
    } catch (error) {
      throw new NonRetryableError(
        `dedupe: adapter "${adapter.sourceKind}" failed on ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const match = entries.find(
      (entry) =>
        entry.sourceKind === signal.sourceKind &&
        entry.sourceId !== null &&
        entry.sourceId === signal.sourceId,
    );
    if (match) {
      return {
        text: match.originalText,
        rating: canonicalizeRating(match.rating),
        occurredAt: new Date(match.occurredAt),
        // NormalizedSignal carries no source update time yet; adapters that
        // learn one (Epic #7/#8) extend the contract and thread it here.
        sourceUpdatedAt: null,
      };
    }
  }

  throw new NonRetryableError(
    `dedupe: conflict_reimport for signal ${message.signalId} (source_id ` +
      `${signal.sourceId}) but no matching entry in the run's artifacts`,
  );
}

/**
 * The fuzzy path: embed (or reuse) the signal's text, pull the ANN
 * candidate pool, apply the in-code predicates, and link the hits for
 * human review. The signal ALWAYS proceeds to classify afterwards — a
 * suspected duplicate is information for a human, never a gate.
 */
async function handleFuzzyCandidates(
  message: DedupeMessage,
  deps: DedupeDeps,
  record: SignalWithCurrentContent,
): Promise<void> {
  const { signal } = record;

  if (!hasEmbeddableText(record.currentText)) {
    // Nothing to embed, nothing to compare — rating-only signals pass
    // straight through (the exact path still protects their identity).
    log("info", "pipeline.dedupe.fuzzy_skipped_no_text", message);
    return;
  }

  if (!deps.embedder) {
    // No AI binding in this environment (e.g. local dev — see module doc);
    // skip loudly, never fake a vector.
    log("warn", "pipeline.dedupe.fuzzy_skipped_no_embedder", message, {
      reason: "AI binding not configured — Workers AI bge-m3 unavailable",
    });
    return;
  }

  let embedding = signal.embedding;
  if (embedding === null) {
    embedding = await deps.embedder.embedText(record.currentText);
    await deps.store.saveEmbedding(signal.id, embedding);
  }

  const candidates = await deps.store.findCandidates({
    practiceId: message.practiceId,
    excludeSignalId: signal.id,
    embedding,
    occurredAt: signal.occurredAt,
  });

  const self = {
    rating: record.currentRating,
    sourceKind: signal.sourceKind,
    sourceId: signal.sourceId,
  };
  const links: SuspectedDuplicateLink[] = candidates
    .filter((candidate) =>
      isSuspectedDuplicate(
        candidate,
        self,
        FUZZY_DUPLICATE_SIMILARITY_THRESHOLD,
      ),
    )
    .map((candidate) => ({
      practiceId: message.practiceId,
      signalIdX: signal.id,
      signalIdY: candidate.id,
      similarity: candidate.similarity,
    }));

  if (links.length > 0) {
    const inserted = await deps.store.recordSuspectedDuplicates(message, links);
    log("info", "pipeline.dedupe.suspected_duplicates", message, {
      candidates: candidates.length,
      linked: links.length,
      inserted,
    });
  }
}

/**
 * Production `DedupeStore` over the Drizzle client. Every count update
 * shares a transaction with the row write it describes (#111).
 */
export function createDedupeStore(db: Db): DedupeStore {
  return {
    getSignal: (signalId) => getSignalWithCurrentContent(db, signalId),
    getImportRunArtifactKeys: (importRunId) =>
      getImportRunArtifactKeys(db, importRunId),
    recordUnchangedReimport: (message) =>
      incrementImportRunCounts(db, message.importRunId, { skipped: 1 }),
    recordEditedReimport: (message, incoming, embedding) =>
      db.transaction(async (tx) => {
        const version = await recordSignalVersion(tx, {
          signalId: message.signalId,
          content: incoming.text,
          rating: incoming.rating,
          sourceUpdatedAt: incoming.sourceUpdatedAt,
          embedding,
        });
        await incrementImportRunCounts(tx, message.importRunId, { merged: 1 });
        // Same-transaction audit (packages/db convention): the version
        // event exists iff its rows do. References only — never content.
        await audit(tx, {
          practiceId: message.practiceId,
          actor: { type: "system", id: "pipeline:dedupe" },
          action: "signal.version_recorded",
          entityType: "signals",
          entityId: message.signalId,
          payload: {
            versionId: version.id,
            importRunId: message.importRunId,
          },
        });
      }),
    saveEmbedding: (signalId, embedding) =>
      updateSignalEmbedding(db, signalId, embedding),
    findCandidates: (params) =>
      findDuplicateCandidates(db, {
        ...params,
        windowDays: FUZZY_DUPLICATE_WINDOW_DAYS,
        limit: FUZZY_DUPLICATE_CANDIDATE_LIMIT,
      }),
    recordSuspectedDuplicates: (message, links) =>
      db.transaction(async (tx) => {
        const inserted = await insertSuspectedDuplicates(tx, links);
        if (inserted > 0) {
          await incrementImportRunCounts(
            tx,
            message.importRunId,
            {},
            { suspected_duplicates: inserted },
          );
        }
        return inserted;
      }),
    markReadyForClassify: (signalId) =>
      setSignalPipelineStatus(db, signalId, "pending_classify"),
  };
}

/**
 * Resolves the production embedding provider (issue #71): Workers AI
 * `@cf/baai/bge-m3` over the `AI` binding, shared with the classify
 * stage's inline excerpt embedding. `undefined` when the binding is
 * absent — preview/prod bind it; the local wrangler block deliberately
 * does not (see wrangler.jsonc), so the fuzzy path skips loudly there.
 */
function resolveEmbeddingProvider(
  env: PipelineBindings,
): EmbeddingProvider | undefined {
  return env.AI ? createWorkersAiEmbedder(env.AI) : undefined;
}

/**
 * The wired handler: per-message client over the Hyperdrive binding
 * (isolates cannot share sockets; Hyperdrive makes reconnects cheap).
 */
export const dedupe: StageHandler<"dedupe"> = async (message, env) => {
  if (!env.HYPERDRIVE) {
    // A topology bug, not a bad message — retry → DLQ keeps it replayable.
    throw new RetryableError(
      "dedupe: HYPERDRIVE binding is missing — the dedupe stage needs " +
        "Postgres (see workers/pipeline/wrangler.jsonc)",
    );
  }
  const { db, sql } = createDb(env.HYPERDRIVE.connectionString);
  try {
    await dedupeSignal(message, env, {
      store: createDedupeStore(db),
      embedder: resolveEmbeddingProvider(env),
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
};
