/**
 * `recordPipelineFailure()` — the persistence seam for pipeline dead-letter
 * messages (issue #98, Epic #6).
 *
 * The DLQ consumer in `workers/pipeline` calls this for every message that
 * lands on a `wr-<stage>-dlq` queue, so a poison message can never vanish:
 * stage, reason, error, the raw body, and when it happened.
 *
 * TODO(#111): persist into the `import_runs` error record once that table
 * and its writer exist. #111 owns the failure-record shape; when it lands,
 * this function gains a `Db` handle (first parameter, matching the package
 * convention of `audit()` and the query modules) and writes a row keyed by
 * the failure's `importRunId` where the body carries one. Until then this
 * logs a single structured line — visible in `wrangler tail` / dev output —
 * so failures are observable even before they are queryable.
 */

import type { PipelineFailure } from "@wellregarded/core";

/** A dead-lettered pipeline message, normalized by `interpretDlqMessage`. */
export interface PipelineFailureRecord extends PipelineFailure {
  /** When the message landed on the DLQ (the DLQ message's timestamp). */
  occurredAt: Date;
}

/**
 * Records a dead-lettered pipeline message. Currently log-only (see the
 * module header); callers should treat it as fallible I/O — catch, log, and
 * still ack, since a DLQ consumer must never retry into a loop.
 */
export async function recordPipelineFailure(
  failure: PipelineFailureRecord,
): Promise<void> {
  // TODO(#111): replace with an `import_runs` write (see module header).
  console.error(
    JSON.stringify({
      event: "pipeline.failure",
      stage: failure.stage,
      reason: failure.reason,
      errorMessage: failure.errorMessage,
      body: failure.body,
      occurredAt: failure.occurredAt.toISOString(),
    }),
  );
}
