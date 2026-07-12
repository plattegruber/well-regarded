/**
 * Types for the jobs worker's environment — same split of responsibilities
 * as `workers/pipeline/src/bindings.ts` (string vars via
 * `getEnv(env, jobsEnvSchema)`; resource bindings typed structurally here
 * so tests can inject minimal fakes).
 */

import type { WorkersAiBinding } from "@wellregarded/ai";
import type { IngestMessage } from "@wellregarded/core";
import type { RawArtifactBucket, RawImportBucket } from "@wellregarded/sources";

import type { GbpSyncInput } from "./gbpSync";
import type { RunSyncResult } from "./sync-lock";

/** The subset of a Workflow binding the local trigger route uses. */
export interface WorkflowBinding {
  create(options?: { id?: string; params?: unknown }): Promise<{ id: string }>;
}

/**
 * The RPC surface of a `SyncLock` DO stub the handlers call. Method
 * shorthand on purpose (bivariant parameters), so the real
 * `DurableObjectNamespace` satisfies this structurally while tests inject
 * plain fakes.
 */
export interface SyncLockStub {
  runSync(input: GbpSyncInput): Promise<RunSyncResult>;
}

export interface SyncLockNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): SyncLockStub;
}

export interface JobsBindings {
  /** Enqueue work at the top of the pipeline spine (`wr-ingest`). */
  INGEST_QUEUE?: { send(body: IngestMessage): Promise<void> } | undefined;
  /**
   * Uploaded CSV imports (`{practiceId}/imports/{sha256}.csv`, #133) —
   * the CSV import Workflow (#135) reads the confirmed draft's file from
   * here. Structural (`RawImportBucket`) so tests inject the in-memory
   * fake; the real `R2Bucket` satisfies it.
   */
  RAW_IMPORTS?: RawImportBucket | undefined;
  /**
   * The pipeline's immutable raw-artifact bucket (#100,
   * `wr-raw-artifacts-<env>`) — the CSV import Workflow (#135) writes its
   * batch envelopes and the GBP poller (#123) its review-page envelopes
   * here BEFORE enqueueing (store-before-enqueue); the pipeline's
   * normalize stage reads them.
   */
  RAW_ARTIFACTS?: RawArtifactBucket | undefined;
  /** Per-connection GBP sync locks (#123) — the `SyncLock` DO namespace. */
  SYNC_LOCK?: SyncLockNamespace | undefined;
  /**
   * Postgres via Hyperdrive — the embedding backfill Workflow (#71), the
   * CSV import Workflow (#135), and the GBP poller (#123) read/write
   * through this. Structural so tests inject `{ connectionString }`.
   */
  HYPERDRIVE?: { connectionString: string } | undefined;
  /**
   * Workers AI, for bge-m3 embeddings in the backfill Workflow (#71).
   * Structural (the `run` subset the embedder calls).
   */
  AI?: WorkersAiBinding | undefined;
  /** The `wr-embedding-backfill` Workflow (class `EmbeddingBackfill`). */
  EMBEDDING_BACKFILL?: WorkflowBinding | undefined;
  /** The `wr-csv-import` Workflow (class `CsvImport`, issue #135). */
  CSV_IMPORT?: WorkflowBinding | undefined;
  /** String vars/secrets, validated by `getEnv(env, jobsEnvSchema)`. */
  [key: string]: unknown;
}
