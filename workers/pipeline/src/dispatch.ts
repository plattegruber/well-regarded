/**
 * Queue dispatcher (issue #98, Epic #6): one `queue()` handler for all eight
 * queues (four stages + four DLQs), dispatching on `batch.queue`.
 *
 * Ack/retry semantics live HERE, not in stage handlers:
 *
 * - handler returns                → `message.ack()`
 * - handler throws NonRetryableError → forward envelope to the stage DLQ,
 *   then `ack()` (no retry budget burned on a permanent failure)
 * - handler throws anything else   → `message.retry()` (Queues honors
 *   `max_retries: 3`, then dead-letters to the stage's DLQ itself)
 * - body fails zod parsing         → do NOT retry (it will never parse):
 *   forward envelope to the stage DLQ, then `ack()`
 * - the DLQ forward itself fails   → `retry()` — the one case where a
 *   malformed message retries, so it is never silently dropped
 * - DLQ queues                     → persist via `handleDlqMessage`, then
 *   `ack()` unconditionally (a DLQ consumer must never retry into a loop)
 *
 * Messages are acked/retried individually (never `batch.ackAll()`), so one
 * poison message doesn't nuke its batch-mates.
 */

import {
  buildDlqForwardEnvelope,
  createLogger,
  extractRequestId,
  fallbackRequestId,
  getEnv,
  identifyPipelineQueue,
  type Logger,
  type LogLevel,
  logLevelFor,
  NonRetryableError,
  type PipelineStage,
  parsePipelineMessage,
  pipelineEnvSchema,
} from "@wellregarded/core";

import { dlqProducerFor, type PipelineBindings } from "./bindings";
import { handleDlqMessage, type StageHandler, stageHandlers } from "./stages";

/** The full handler map, injectable so tests can stub stage behavior. */
export type StageHandlers = { [S in PipelineStage]: StageHandler<S> };

/**
 * Structural subset of a Cloudflare Queues `Message` — what the dispatcher
 * actually touches, so tests can inject plain fakes.
 */
export interface QueueMessageLike {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

/** Structural subset of a Cloudflare Queues `MessageBatch`. */
export interface QueueBatchLike {
  readonly queue: string;
  readonly messages: readonly QueueMessageLike[];
}

/**
 * Entry point wired to the worker's `queue()` export. `handlers` defaults to
 * the real stage modules; tests inject fakes to exercise the ack/retry paths.
 */
export async function handleQueueBatch(
  batch: QueueBatchLike,
  env: PipelineBindings,
  handlers: StageHandlers = stageHandlers,
): Promise<void> {
  // Fail fast on a misconfigured deploy, per the getEnv contract.
  const vars = getEnv(env, pipelineEnvSchema);
  const level = logLevelFor(vars.ENVIRONMENT);

  const identity = identifyPipelineQueue(batch.queue);
  if (identity === null) {
    // A queue this worker never expected — a topology/config bug, not a bad
    // message. Retry: after max_retries the platform dead-letters it (if the
    // queue has a DLQ), which beats dropping it on the floor here.
    // Batch-level failure: no message context, so the requestId is minted.
    createLogger({
      worker: "pipeline",
      requestId: fallbackRequestId(),
      level,
    }).error("pipeline.dispatch.unknown_queue", { queue: batch.queue });
    for (const message of batch.messages) {
      message.retry();
    }
    return;
  }

  for (const message of batch.messages) {
    if (identity.isDlq) {
      await consumeDlqMessage(identity.stage, message, env, level);
    } else {
      await consumeStageMessage(
        identity.stage,
        batch.queue,
        message,
        env,
        handlers,
        level,
      );
    }
  }
}

/** One main-queue message: parse → handler → ack/retry/dead-letter. */
async function consumeStageMessage(
  stage: PipelineStage,
  queueName: string,
  message: QueueMessageLike,
  env: PipelineBindings,
  handlers: StageHandlers,
  level: LogLevel,
): Promise<void> {
  const parsed = parsePipelineMessage(queueName, message.body);
  if (!parsed.ok) {
    // Will never parse — retrying is pointless. Forward to the DLQ so it
    // still lands in failure tracking, then ack on the main queue. The
    // requestId is pulled from the body best-effort so even a malformed
    // message stays greppable by its trace.
    const log = createLogger({
      worker: "pipeline",
      requestId: extractRequestId(message.body),
      stage,
      level,
    });
    await forwardToDlq(
      stage,
      "malformed",
      parsed.error.detail,
      message,
      env,
      log,
    );
    return;
  }

  // The message's requestId (backfilled by the parser for legacy messages)
  // binds every log line from this hop to the signal's journey.
  const log = createLogger({
    worker: "pipeline",
    requestId: parsed.message.requestId,
    practiceId: parsed.message.practiceId,
    stage: parsed.stage,
    level,
  });

  try {
    // `parsed` is discriminated on `stage`, so the handler receives exactly
    // its own message type.
    await handlers[parsed.stage](parsed.message as never, env);
    message.ack();
  } catch (error) {
    if (error instanceof NonRetryableError) {
      await forwardToDlq(
        stage,
        "non_retryable",
        error.message,
        message,
        env,
        log,
      );
      return;
    }
    // RetryableError and anything unexpected: might be transient. Queues
    // honors max_retries: 3, then dead-letters to the stage's DLQ.
    log.error("pipeline.dispatch.retry", {
      queue: queueName,
      messageId: message.id,
      error,
    });
    message.retry();
  }
}

/**
 * Wraps the original body in a `DlqForwardEnvelope` (preserving the error
 * next to the body) and sends it to the stage's DLQ, then acks the main-queue
 * message. If the DLQ send itself fails, the message retries instead — a
 * failure record must never be silently dropped.
 */
async function forwardToDlq(
  stage: PipelineStage,
  reason: "malformed" | "non_retryable",
  errorMessage: string,
  message: QueueMessageLike,
  env: PipelineBindings,
  log: Logger,
): Promise<void> {
  const envelope = buildDlqForwardEnvelope({
    stage,
    reason,
    error: errorMessage,
    body: message.body,
    // Producers propagate the trace id (issue #64): the DLQ record stays
    // greppable by the same requestId as the rest of the signal's journey.
    requestId: log.requestId,
  });
  try {
    await dlqProducerFor(stage, env).send(envelope);
  } catch (sendError) {
    log.error("pipeline.dispatch.dlq_forward_failed", {
      reason,
      messageId: message.id,
      error: sendError,
    });
    message.retry();
    return;
  }
  message.ack();
}

/**
 * One DLQ message: persist the failure, then ack unconditionally — even when
 * persistence throws (logged; the message is in the consumer logs). A DLQ
 * consumer must never retry into a loop.
 */
async function consumeDlqMessage(
  stage: PipelineStage,
  message: QueueMessageLike,
  env: PipelineBindings,
  level: LogLevel,
): Promise<void> {
  try {
    await handleDlqMessage(stage, message.body, message.timestamp, env);
  } catch (error) {
    // extractRequestId reads the forwarded envelope's requestId (or the
    // bare body's, for platform dead-letters) so the failure stays traceable.
    createLogger({
      worker: "pipeline",
      requestId: extractRequestId(message.body),
      stage,
      level,
    }).error("pipeline.dlq.record_failed", {
      messageId: message.id,
      error,
    });
  } finally {
    message.ack();
  }
}
