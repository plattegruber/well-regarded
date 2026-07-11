import type { PipelineStage } from "@wellregarded/core";
import {
  createLogger,
  extractRequestId,
  interpretDlqMessage,
} from "@wellregarded/core";
import { createDb, recordPipelineFailure } from "@wellregarded/db";

import type { PipelineBindings } from "../bindings";

/**
 * DLQ stage — shared consumer of all four `wr-<stage>-dlq` queues.
 *
 * Normalizes whatever landed on the DLQ (a dispatcher-forwarded envelope for
 * malformed/non-retryable messages, or the bare original body when Cloudflare
 * Queues dead-lettered it after `max_retries`) and persists it through
 * `recordPipelineFailure` in `packages/db` (#111): a structured log line
 * always, plus an `import_runs.error_samples` append + `failed` increment
 * when the body names its run.
 *
 * When no database is bound (a misconfigured env must not swallow
 * failures), the record degrades to the log line alone.
 *
 * The dispatcher acks DLQ messages *unconditionally* (even if this throws):
 * a DLQ consumer must never retry into a loop.
 */
export async function handleDlqMessage(
  stage: PipelineStage,
  body: unknown,
  occurredAt: Date,
  env: PipelineBindings,
): Promise<void> {
  const failure = { ...interpretDlqMessage(stage, body), occurredAt };

  const connectionString = (
    env.HYPERDRIVE as { connectionString?: string } | undefined
  )?.connectionString;
  if (!connectionString) {
    // Log-only fallback — mirrors recordPipelineFailure's first sink so the
    // failure is still observable in `wrangler tail`. Best-effort requestId
    // from the envelope/body keeps it greppable (issue #64).
    createLogger({
      worker: "pipeline",
      requestId: extractRequestId(body),
      stage,
    }).error("pipeline.failure", {
      reason: failure.reason,
      errorMessage: failure.errorMessage,
      body: failure.body,
      occurredAt: failure.occurredAt.toISOString(),
      note: "no HYPERDRIVE binding — failure recorded in logs only",
    });
    return;
  }

  const { db, sql } = createDb(connectionString);
  try {
    await recordPipelineFailure(db, failure);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
