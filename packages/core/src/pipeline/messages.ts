/**
 * Typed message contracts for the ingestion pipeline (issue #98, Epic #6).
 *
 * The pipeline is a chain of Cloudflare Queues consumed by `workers/pipeline`:
 *
 *   wr-ingest --(normalize)--> wr-dedupe --> wr-classify --> wr-route
 *
 * Each queue carries exactly one message shape, defined here as a zod schema
 * with an inferred TS type, so producers (`workers/api`, `workers/jobs`, and
 * each stage feeding the next) and consumers share one contract. Messages
 * stay deliberately small and replayable: downstream stages carry only ids
 * and re-read the `signals` row — a message never embeds content that could
 * go stale in flight.
 *
 * Queue *names* follow `wr-<stage>[-dlq][-<env>]` (see infra/environments.md:
 * local names are unsuffixed, preview/prod are env-suffixed), so consumers
 * dispatch on `batch.queue` via `identifyPipelineQueue` rather than string
 * equality.
 */

import { z } from "zod";

import { SOURCE_KINDS } from "../signals.js";

/** Pipeline stages, in spine order. Each has a queue and a DLQ. */
export const PIPELINE_STAGES = [
  "ingest",
  "dedupe",
  "classify",
  "route",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/**
 * `wr-ingest` — enqueued by `workers/api` / `workers/jobs` after the raw
 * artifact is persisted to R2 (#101) and an `import_runs` row exists (#111).
 * Consumed by the normalize stage (#104).
 */
export const ingestMessageSchema = z.object({
  /** `import_runs` row this message belongs to (#111). */
  importRunId: z.uuid(),
  /** R2 key of the immutable raw artifact (content-addressed, #101). */
  rawArtifactKey: z.string().min(1),
  sourceKind: z.enum(SOURCE_KINDS),
  practiceId: z.uuid(),
});

export type IngestMessage = z.infer<typeof ingestMessageSchema>;

// Downstream stages all carry the same tiny reference shape: the stage
// re-reads the `signals` row, so the message is just "which signal, whose,
// from which run". Separate schemas (not one alias) so a stage can grow a
// field later without touching its neighbors.
const signalStageShape = {
  signalId: z.uuid(),
  practiceId: z.uuid(),
  importRunId: z.uuid(),
};

/** `wr-dedupe` — enqueued by normalize once a `signals` row exists. */
export const dedupeMessageSchema = z.object(signalStageShape);

export type DedupeMessage = z.infer<typeof dedupeMessageSchema>;

/** `wr-classify` — enqueued by dedupe for signals that survived dedup. */
export const classifyMessageSchema = z.object(signalStageShape);

export type ClassifyMessage = z.infer<typeof classifyMessageSchema>;

/** `wr-route` — enqueued by classify once derivations are written. */
export const routeMessageSchema = z.object(signalStageShape);

export type RouteMessage = z.infer<typeof routeMessageSchema>;

/** Schema for each stage's inbound queue, keyed by stage. */
export const pipelineMessageSchemas = {
  ingest: ingestMessageSchema,
  dedupe: dedupeMessageSchema,
  classify: classifyMessageSchema,
  route: routeMessageSchema,
} as const;

/** The message type a given stage consumes. */
export type PipelineMessageFor<S extends PipelineStage> = z.infer<
  (typeof pipelineMessageSchemas)[S]
>;

/** Union of every pipeline message shape. */
export type PipelineMessage = PipelineMessageFor<PipelineStage>;

/** What a pipeline queue name identifies: its stage, and main queue vs DLQ. */
export interface PipelineQueueIdentity {
  stage: PipelineStage;
  isDlq: boolean;
}

// `wr-<stage>` plus optional `-dlq`, plus the optional environment suffix
// from infra/environments.md (local queue names are unsuffixed).
const QUEUE_NAME_PATTERN =
  /^wr-(ingest|dedupe|classify|route)(-dlq)?(?:-(preview|prod))?$/;

/**
 * Resolves a concrete queue name (`batch.queue`) to its pipeline stage.
 * Handles the environment suffix — `wr-dedupe`, `wr-dedupe-preview`, and
 * `wr-dedupe-prod` are all the dedupe stage — and distinguishes DLQs.
 * Returns `null` for names outside the pipeline topology.
 */
export function identifyPipelineQueue(
  queueName: string,
): PipelineQueueIdentity | null {
  const match = QUEUE_NAME_PATTERN.exec(queueName);
  if (!match) {
    return null;
  }
  return {
    stage: match[1] as PipelineStage,
    isDlq: match[2] !== undefined,
  };
}

/** Typed failure from `parsePipelineMessage` — returned, never thrown. */
export type PipelineMessageError =
  | {
      /** The queue name is not a main pipeline queue (DLQs included: their
       * bodies are failure envelopes, not stage messages). */
      kind: "unknown_queue";
      queueName: string;
      detail: string;
    }
  | {
      /** The body failed the stage's zod schema. Permanent: the same bytes
       * will never parse, so callers must NOT retry — dead-letter instead. */
      kind: "invalid_message";
      queueName: string;
      stage: PipelineStage;
      detail: string;
    };

/** Result of `parsePipelineMessage`: a typed message or a typed error. */
export type ParsePipelineMessageResult =
  | {
      [S in PipelineStage]: {
        ok: true;
        stage: S;
        message: PipelineMessageFor<S>;
      };
    }[PipelineStage]
  | { ok: false; error: PipelineMessageError };

/**
 * Validates a raw queue message body against the schema of the stage that
 * `queueName` belongs to. Returns the typed message (discriminated on
 * `stage`) or a typed error — it never throws, and an `invalid_message`
 * error means "do not retry".
 */
export function parsePipelineMessage(
  queueName: string,
  body: unknown,
): ParsePipelineMessageResult {
  const identity = identifyPipelineQueue(queueName);
  if (identity === null || identity.isDlq) {
    return {
      ok: false,
      error: {
        kind: "unknown_queue",
        queueName,
        detail:
          identity === null
            ? `"${queueName}" is not a pipeline queue (expected wr-<stage>[-<env>])`
            : `"${queueName}" is a DLQ; DLQ bodies are failure envelopes, not stage messages`,
      },
    };
  }
  const result = pipelineMessageSchemas[identity.stage].safeParse(body);
  if (!result.success) {
    return {
      ok: false,
      error: {
        kind: "invalid_message",
        queueName,
        stage: identity.stage,
        detail: z.prettifyError(result.error),
      },
    };
  }
  // The stage↔schema correlation is guaranteed by the lookup above but not
  // tracked by the compiler across the indexed access, hence the assertion.
  return {
    ok: true,
    stage: identity.stage,
    message: result.data,
  } as ParsePipelineMessageResult;
}

/**
 * Why a message landed on a DLQ.
 *
 * - `malformed` — failed the stage schema; forwarded by the dispatcher
 *   (retrying would never help).
 * - `non_retryable` — the handler threw `NonRetryableError`; forwarded by
 *   the dispatcher.
 * - `retries_exhausted` — the handler kept failing and Cloudflare Queues
 *   dead-lettered the message itself after `max_retries`. Such messages
 *   arrive as the *bare original body* (no envelope).
 */
export const DLQ_FAILURE_REASONS = [
  "malformed",
  "non_retryable",
  "retries_exhausted",
] as const;

export type DlqFailureReason = (typeof DLQ_FAILURE_REASONS)[number];

/** Discriminator for envelopes the dispatcher forwards to a DLQ itself. */
export const DLQ_FORWARD_KIND = "wr.pipeline.dlq-forward";

/**
 * Envelope the dispatcher wraps around a message it forwards to a DLQ
 * directly (malformed or non-retryable), preserving the error alongside the
 * original body. Platform dead-letters (`retries_exhausted`) carry no
 * envelope — `interpretDlqMessage` normalizes both shapes.
 */
export const dlqForwardEnvelopeSchema = z.object({
  kind: z.literal(DLQ_FORWARD_KIND),
  stage: z.enum(PIPELINE_STAGES),
  reason: z.enum(["malformed", "non_retryable"]),
  error: z.string(),
  /** The original message body, exactly as it appeared on the main queue. */
  body: z.unknown(),
  occurredAt: z.iso.datetime(),
});

export type DlqForwardEnvelope = z.infer<typeof dlqForwardEnvelopeSchema>;

/** Builds the envelope the dispatcher sends when it forwards to a DLQ. */
export function buildDlqForwardEnvelope(input: {
  stage: PipelineStage;
  reason: "malformed" | "non_retryable";
  error: string;
  body: unknown;
}): DlqForwardEnvelope {
  return {
    kind: DLQ_FORWARD_KIND,
    ...input,
    occurredAt: new Date().toISOString(),
  };
}

/** Normalized view of any DLQ message, whatever path it took to get there. */
export interface PipelineFailure {
  stage: PipelineStage;
  reason: DlqFailureReason;
  /** Human-readable error. Platform dead-letters carry none. */
  errorMessage: string;
  /** The original main-queue message body. */
  body: unknown;
}

/**
 * Normalizes a DLQ message body into a `PipelineFailure`: dispatcher-forwarded
 * envelopes contribute their recorded reason and error; anything else is a
 * platform dead-letter whose original body arrives bare.
 */
export function interpretDlqMessage(
  stage: PipelineStage,
  body: unknown,
): PipelineFailure {
  const envelope = dlqForwardEnvelopeSchema.safeParse(body);
  if (envelope.success) {
    return {
      stage: envelope.data.stage,
      reason: envelope.data.reason,
      errorMessage: envelope.data.error,
      body: envelope.data.body,
    };
  }
  return {
    stage,
    reason: "retries_exhausted",
    errorMessage:
      "max_retries exhausted; dead-lettered by Cloudflare Queues (per-attempt errors are in the consumer logs)",
    body,
  };
}
