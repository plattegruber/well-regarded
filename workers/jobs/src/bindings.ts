/**
 * Types for the jobs worker's environment — same split of responsibilities
 * as `workers/pipeline/src/bindings.ts` (string vars via
 * `getEnv(env, jobsEnvSchema)`; resource bindings typed structurally here
 * so tests can inject minimal fakes).
 */

import type { WorkersAiBinding } from "@wellregarded/ai";

/** The subset of a Workflow binding the local trigger route uses. */
export interface WorkflowBinding {
  create(options?: { id?: string; params?: unknown }): Promise<{ id: string }>;
}

export interface JobsBindings {
  /** Enqueue work at the top of the pipeline spine (`wr-ingest`). */
  INGEST_QUEUE?: { send(body: unknown): Promise<void> } | undefined;
  /**
   * Postgres via Hyperdrive — the embedding backfill Workflow (#71) reads
   * and updates `proof_excerpts` through this. Structural so tests inject
   * `{ connectionString }`.
   */
  HYPERDRIVE?: { connectionString: string } | undefined;
  /**
   * Workers AI, for bge-m3 embeddings in the backfill Workflow (#71).
   * Structural (the `run` subset the embedder calls).
   */
  AI?: WorkersAiBinding | undefined;
  /** The `wr-embedding-backfill` Workflow (class `EmbeddingBackfill`). */
  EMBEDDING_BACKFILL?: WorkflowBinding | undefined;
  /** String vars/secrets, validated by `getEnv(env, jobsEnvSchema)`. */
  [key: string]: unknown;
}
