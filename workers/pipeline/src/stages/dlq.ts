import type { PipelineStage } from "@wellregarded/core";
import { interpretDlqMessage } from "@wellregarded/core";
import { recordPipelineFailure } from "@wellregarded/db";

/**
 * DLQ stage — shared consumer of all four `wr-<stage>-dlq` queues.
 *
 * Normalizes whatever landed on the DLQ (a dispatcher-forwarded envelope for
 * malformed/non-retryable messages, or the bare original body when Cloudflare
 * Queues dead-lettered it after `max_retries`) and persists it through
 * `recordPipelineFailure` — currently a log-only seam in `packages/db`;
 * #111 turns it into an `import_runs` write.
 *
 * The dispatcher acks DLQ messages *unconditionally* (even if this throws):
 * a DLQ consumer must never retry into a loop.
 */
export async function handleDlqMessage(
  stage: PipelineStage,
  body: unknown,
  occurredAt: Date,
): Promise<void> {
  const failure = interpretDlqMessage(stage, body);
  await recordPipelineFailure({ ...failure, occurredAt });
}
