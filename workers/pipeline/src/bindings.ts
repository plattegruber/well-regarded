/**
 * Types for the pipeline worker's environment.
 *
 * Split of responsibilities (see packages/core/src/env.ts header):
 * - string vars/secrets are validated per-batch via
 *   `getEnv(env, pipelineEnvSchema)` — never read them off `env` directly;
 * - resource bindings (queue producers) are runtime-injected objects typed
 *   here, consumed directly off `env`.
 *
 * Everything is typed structurally (not via `Queue` from workers-types) so
 * tests can inject minimal fakes — the same pattern as `ApiBindings` in
 * workers/api.
 */

import type { WorkersAiBinding } from "@wellregarded/ai";
import type { PipelineStage } from "@wellregarded/core";
import type { RawArtifactBucket } from "@wellregarded/sources";

/** The one method the dispatcher uses on a queue producer binding. */
export interface QueueProducer {
  send(body: unknown): Promise<void>;
}

/**
 * The bindings this worker's code actually consumes. wrangler.jsonc's
 * binding list is the source of truth (names are API surface — see
 * docs/architecture-bindings.md).
 */
export interface PipelineBindings {
  /** Next-stage producers: normalize → dedupe → classify → route. */
  DEDUPE_QUEUE: QueueProducer;
  CLASSIFY_QUEUE: QueueProducer;
  ROUTE_QUEUE: QueueProducer;
  /** Per-stage DLQ producers, for the malformed/non-retryable forward path. */
  INGEST_DLQ: QueueProducer;
  DEDUPE_DLQ: QueueProducer;
  CLASSIFY_DLQ: QueueProducer;
  ROUTE_DLQ: QueueProducer;
  /**
   * Local-only (bound in the top-level `wrangler.jsonc` block, never in
   * preview/prod): lets the `/__local/enqueue/ingest` debug endpoint feed
   * the spine's front door. Deployed producers to `wr-ingest` live in
   * workers/api and workers/jobs.
   */
  INGEST_QUEUE?: QueueProducer;
  /**
   * Postgres via Hyperdrive — the normalize stage (#104) writes `signals`
   * rows and `import_runs` counts, the classify stage (#67) re-reads
   * `signals` and writes `derivations`, and the DLQ consumer persists
   * failures (#111). Structural (not the workers-types `Hyperdrive`) so
   * tests can inject `{ connectionString }`; optional in the type because
   * misconfiguration is handled at the stage (retry → DLQ) or by the DLQ
   * consumer's log-only fallback, not by crashing the whole dispatcher.
   */
  HYPERDRIVE?: { connectionString: string } | undefined;
  /**
   * R2 bucket of immutable raw artifacts (#100), `wr-raw-artifacts-<env>`.
   * Typed structurally (the subset `getRawArtifact` needs) so tests can
   * inject `InMemoryRawArtifactBucket`; the real `R2Bucket` satisfies it.
   */
  RAW_ARTIFACTS: RawArtifactBucket;
  /**
   * Workers AI, for inline bge-m3 excerpt embeddings in the classify stage
   * (issue #71). Typed structurally (the `run` subset the embedder calls)
   * so tests inject plain fakes. Optional because a missing binding only
   * degrades embeddings to NULL (backfill sweeps them) — it never blocks
   * the message.
   */
  AI?: WorkersAiBinding | undefined;
  /** String vars/secrets, validated by `getEnv(env, pipelineEnvSchema)`. */
  [key: string]: unknown;
}

/** The DLQ producer binding for each stage. */
export const DLQ_BINDING_BY_STAGE = {
  ingest: "INGEST_DLQ",
  dedupe: "DEDUPE_DLQ",
  classify: "CLASSIFY_DLQ",
  route: "ROUTE_DLQ",
} as const satisfies Record<PipelineStage, keyof PipelineBindings>;

/** Resolves the DLQ producer for a stage. */
export function dlqProducerFor(
  stage: PipelineStage,
  env: PipelineBindings,
): QueueProducer {
  return env[DLQ_BINDING_BY_STAGE[stage]];
}
