import type {
  PipelineStage,
  TracedPipelineMessageFor,
} from "@wellregarded/core";

import type { PipelineBindings } from "../bindings";

/**
 * A stage handler is a pure-ish function over an already-validated message —
 * no batch, no ack/retry. The dispatcher (src/dispatch.ts) owns parsing and
 * ack/retry semantics; the test harness (#113) can invoke handlers directly
 * without constructing a MessageBatch.
 *
 * Failure vocabulary (enforced by the dispatcher):
 * - return                     → ack
 * - throw RetryableError / any → retry (max_retries: 3, then dead-letter)
 * - throw NonRetryableError    → forward to the stage DLQ + ack
 *
 * Messages arrive as `TracedPipelineMessageFor<S>`: the wire-optional
 * `requestId` (issue #64) is guaranteed by `parsePipelineMessage`, so a
 * handler can bind its logger — and stamp its next-stage message — with
 * `message.requestId` unconditionally.
 */
export type StageHandler<S extends PipelineStage> = (
  message: TracedPipelineMessageFor<S>,
  env: PipelineBindings,
) => Promise<void>;
