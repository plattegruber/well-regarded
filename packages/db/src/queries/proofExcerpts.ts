/**
 * `proof_excerpts` write path and embedding backfill queries (issues #69
 * and #71, Epic #9).
 *
 * Writers: the classify stage's extraction pass inserts rows (embedding
 * NULL) and immediately tries to fill them inline; the backfill Workflow
 * in `workers/jobs` sweeps whatever the inline pass missed. Both go
 * through here — the workers never write inline SQL, and there is exactly
 * one vector serialization (drizzle's `vector` column takes `number[]`).
 */

import { and, asc, eq, gt, isNull, ne, or } from "drizzle-orm";

import type { Db } from "../client.js";
import { proofExcerpts } from "../schema/proofExcerpts.js";
import type { ProofExcerpt } from "./hybridSearch.js";

/** Insert shape for a `proof_excerpts` row. */
export type NewProofExcerpt = typeof proofExcerpts.$inferInsert;

/**
 * The classify consumer's excerpt idempotency probe (issue #69
 * requirement 6): Queues are at-least-once, so redelivery must find the
 * first delivery's rows and skip. Any existing excerpt for the signal
 * counts — extraction writes all of a signal's excerpts in one INSERT, so
 * partial extraction states don't exist.
 */
export async function signalHasProofExcerpts(
  db: Db,
  signalId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: proofExcerpts.id })
    .from(proofExcerpts)
    .where(eq(proofExcerpts.signalId, signalId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Append a signal's excerpts in one multi-row INSERT so a crash can never
 * leave half an extraction behind (the idempotency probe above relies on
 * all-or-nothing writes). Returns the inserted rows — the inline embed
 * pass needs their ids.
 */
export async function insertProofExcerpts(
  db: Db,
  rows: readonly NewProofExcerpt[],
): Promise<ProofExcerpt[]> {
  if (rows.length === 0) return [];
  return db
    .insert(proofExcerpts)
    .values([...rows])
    .returning();
}

/** One embedding write: the vector plus the model that produced it. */
export interface ProofExcerptEmbeddingUpdate {
  id: string;
  /** 1024-dim (bge-m3) vector. */
  embedding: number[];
  /** Concrete model id, stamped alongside the vector (issue #71). */
  embeddingModel: string;
}

/**
 * Fill embeddings on existing rows — the classify stage's inline pass and
 * the backfill Workflow both land here. One UPDATE per row by primary key
 * (batches are ≤ 50 rows; a VALUES join would save little and cost a
 * second vector serialization path).
 */
export async function setProofExcerptEmbeddings(
  db: Db,
  updates: readonly ProofExcerptEmbeddingUpdate[],
): Promise<void> {
  for (const update of updates) {
    await db
      .update(proofExcerpts)
      .set({
        embedding: update.embedding,
        embeddingModel: update.embeddingModel,
      })
      .where(eq(proofExcerpts.id, update.id));
  }
}

export interface ExcerptsNeedingEmbeddingParams {
  /** The model the backfill is bringing every row up to. */
  targetModel: string;
  /** Scope to one practice; omit for a global sweep. */
  practiceId?: string | undefined;
  /**
   * Keyset cursor: only rows with `id > afterId`. The WHERE clause alone
   * already skips embedded rows, but the cursor guarantees forward
   * progress even when a batch's embedding write failed — without it a
   * persistently failing row would loop the backfill forever.
   */
  afterId?: string | undefined;
  /** Batch size. */
  limit: number;
}

/** What the backfill needs from a row: the text to embed, keyed by id. */
export interface ExcerptNeedingEmbedding {
  id: string;
  excerptText: string;
}

/**
 * The backfill's batch query (issue #71 requirement 4): rows whose
 * embedding is missing OR was produced by a different model, in stable id
 * order for keyset pagination. Re-running is idempotent — embedded rows
 * simply stop matching.
 */
export async function excerptsNeedingEmbedding(
  db: Db,
  params: ExcerptsNeedingEmbeddingParams,
): Promise<ExcerptNeedingEmbedding[]> {
  const needsEmbedding = or(
    isNull(proofExcerpts.embedding),
    ne(proofExcerpts.embeddingModel, params.targetModel),
  );
  const conditions = [
    needsEmbedding,
    params.practiceId === undefined
      ? undefined
      : eq(proofExcerpts.practiceId, params.practiceId),
    params.afterId === undefined
      ? undefined
      : gt(proofExcerpts.id, params.afterId),
  ].filter((condition) => condition !== undefined);

  return db
    .select({ id: proofExcerpts.id, excerptText: proofExcerpts.excerptText })
    .from(proofExcerpts)
    .where(and(...conditions))
    .orderBy(asc(proofExcerpts.id))
    .limit(params.limit);
}
