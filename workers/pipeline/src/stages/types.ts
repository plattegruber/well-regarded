import type { PipelineMessageFor, PipelineStage } from "@wellregarded/core";

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
 */
export type StageHandler<S extends PipelineStage> = (
  message: PipelineMessageFor<S>,
  env: PipelineBindings,
) => Promise<void>;
