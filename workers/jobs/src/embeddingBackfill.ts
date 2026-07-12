/**
 * Embedding backfill core (issue #71, Epic #9) — the resumable, rate-aware
 * loop behind the `wr-embedding-backfill` Workflow, kept free of
 * `cloudflare:workers` imports so it runs under plain Node in tests.
 *
 * Why a Workflow: a big backfill outlives any single Worker invocation.
 * Each batch runs inside `step.do`, which the Workflows engine records as
 * a durable checkpoint — after an eviction, crash, or redeploy the engine
 * replays completed steps from storage (their callbacks do NOT re-run) and
 * resumes at the first unfinished batch. `step.sleep` between batches
 * keeps the run inside Workers AI's per-account rate limits: the backfill
 * must degrade to slower, never fail.
 *
 * Idempotency is double-layered: the batch query only matches rows with
 * `embedding IS NULL OR embedding_model != target` (re-running skips
 * already-embedded rows), and the keyset cursor (`afterId`) guarantees
 * forward progress even past a row whose embedding write keeps failing.
 *
 * The split (`runEmbeddingBackfill` orchestration vs `embedExcerptBatch`
 * per-batch work) is the test seam: unit tests drive the orchestration
 * with a fake step + fake batches; integration tests drive
 * `embedExcerptBatch` against real Postgres with the fake embedder.
 */

import type { EmbeddingProvider } from "@wellregarded/ai";
import {
  type Db,
  excerptsNeedingEmbedding,
  setProofExcerptEmbeddings,
} from "@wellregarded/db";

/** Workflow parameters — everything optional, defaults below. */
export interface EmbeddingBackfillParams {
  /** Scope to one practice; null/absent sweeps globally. */
  practiceId?: string | null;
  /** Rows per batch (= per Workflow step). Default 50. */
  batchSize?: number;
  /** Rate-aware pause between batches (issue #71). Default 2000 ms. */
  sleepMs?: number;
}

export const DEFAULT_BACKFILL_BATCH_SIZE = 50;
export const DEFAULT_BACKFILL_SLEEP_MS = 2000;

export interface ResolvedBackfillParams {
  practiceId: string | undefined;
  batchSize: number;
  sleepMs: number;
}

/** Apply defaults; tolerate a missing/partial payload. */
export function resolveBackfillParams(
  params: EmbeddingBackfillParams | undefined,
): ResolvedBackfillParams {
  return {
    practiceId: params?.practiceId ?? undefined,
    batchSize: params?.batchSize ?? DEFAULT_BACKFILL_BATCH_SIZE,
    sleepMs: params?.sleepMs ?? DEFAULT_BACKFILL_SLEEP_MS,
  };
}

/** What one batch reports back to the orchestration loop. */
export interface BackfillBatchResult {
  /** Rows embedded in this batch. */
  processed: number;
  /** Keyset cursor for the next batch; null when the batch was empty. */
  lastId: string | null;
  /** True when this batch drained the remaining rows. */
  done: boolean;
}

/**
 * One batch: select rows still needing an embedding (id-ordered, after the
 * cursor), embed them in one provider call, and write vectors +
 * `embedding_model` back. Runs inside a `step.do`, so a thrown error here
 * is retried by the Workflows engine without re-running earlier batches.
 */
export async function embedExcerptBatch(
  db: Db,
  embedder: EmbeddingProvider,
  opts: {
    practiceId?: string | undefined;
    afterId?: string | undefined;
    batchSize: number;
  },
): Promise<BackfillBatchResult> {
  const rows = await excerptsNeedingEmbedding(db, {
    targetModel: embedder.model,
    practiceId: opts.practiceId,
    afterId: opts.afterId,
    limit: opts.batchSize,
  });
  if (rows.length === 0) {
    return { processed: 0, lastId: null, done: true };
  }

  const vectors = await embedder.embed(rows.map((row) => row.excerptText));
  if (vectors.length !== rows.length) {
    throw new Error(
      `embedding backfill: expected ${rows.length} vectors, got ${vectors.length}`,
    );
  }
  await setProofExcerptEmbeddings(
    db,
    rows.map((row, index) => ({
      id: row.id,
      // Length-checked above; the provider contract preserves order.
      embedding: vectors[index] as number[],
      embeddingModel: embedder.model,
    })),
  );

  const lastId = rows[rows.length - 1]?.id ?? null;
  return {
    processed: rows.length,
    lastId,
    done: rows.length < opts.batchSize,
  };
}

/**
 * Structural subset of the Workflows `WorkflowStep` the loop uses, so
 * tests can inject a fake that memoizes completed steps the way the real
 * engine's durable checkpoints do. Deliberately non-generic: only
 * `BackfillBatchResult` (plain JSON data, as step checkpoints require)
 * ever flows through a step, which also keeps the real `step.do` —
 * typed with `Serializable<T>` — directly assignable.
 */
export interface BackfillStep {
  do(
    name: string,
    callback: () => Promise<BackfillBatchResult>,
  ): Promise<BackfillBatchResult>;
  sleep(name: string, durationMs: number): Promise<void>;
}

export interface EmbeddingBackfillDeps {
  /**
   * One batch of real work, given the cursor. The Workflow wires this to
   * `embedExcerptBatch` over a per-step DB connection; tests fake it.
   */
  processBatch(afterId: string | null): Promise<BackfillBatchResult>;
}

export interface EmbeddingBackfillSummary {
  batches: number;
  embedded: number;
}

/**
 * The orchestration loop: one `step.do` per batch (durable checkpoint),
 * `step.sleep` between batches (rate-aware), keyset cursor threaded
 * through step return values so a resumed run continues where it stopped.
 * Step names are deterministic (`embed-batch-<n>`): the engine keys its
 * checkpoint cache by name, which is exactly what makes replay skip work
 * that already happened.
 */
export async function runEmbeddingBackfill(
  step: BackfillStep,
  deps: EmbeddingBackfillDeps,
  params: ResolvedBackfillParams,
): Promise<EmbeddingBackfillSummary> {
  let afterId: string | null = null;
  let embedded = 0;
  for (let batchIndex = 0; ; batchIndex++) {
    const cursor = afterId;
    const result: BackfillBatchResult = await step.do(
      `embed-batch-${batchIndex}`,
      () => deps.processBatch(cursor),
    );
    embedded += result.processed;
    if (result.done || result.lastId === null) {
      return {
        batches: batchIndex + (result.processed > 0 ? 1 : 0),
        embedded,
      };
    }
    afterId = result.lastId;
    await step.sleep(`pause-after-batch-${batchIndex}`, params.sleepMs);
  }
}
