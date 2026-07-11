/**
 * `recordPipelineFailure()` — the persistence path for pipeline dead-letter
 * messages (issue #98 seam, made durable by issue #111, Epic #6).
 *
 * The DLQ consumer in `workers/pipeline` calls this for every message that
 * lands on a `wr-<stage>-dlq` queue, so a poison message can never vanish:
 * stage, reason, error, the raw body, and when it happened.
 *
 * Two sinks, deliberately both:
 *
 * 1. A structured `pipeline.failure` log line (always, first) — visible in
 *    `wrangler tail` / dev output even when the database write below fails.
 * 2. The owning `import_runs` row (#111): when the dead-lettered body
 *    carries an `importRunId`, the failure is appended to that run's
 *    `error_samples` (bounded; see `appendImportRunError`) and its `failed`
 *    count incremented — which is what makes it visible in
 *    `getImportRunSummary().errorSamples` and the Epic #8 report UI.
 *
 * Bodies without a resolvable `importRunId` (malformed messages may carry
 * anything) stay log-only: there is no run to attribute them to.
 */

import type { PipelineFailure } from "@wellregarded/core";

import type { Tx } from "./audit.js";
import type { Db } from "./client.js";
import { appendImportRunError } from "./queries/importRuns.js";

/** A dead-lettered pipeline message, normalized by `interpretDlqMessage`. */
export interface PipelineFailureRecord extends PipelineFailure {
  /** When the message landed on the DLQ (the DLQ message's timestamp). */
  occurredAt: Date;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Best-effort `importRunId` extraction from an arbitrary DLQ body. */
function extractImportRunId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const candidate = (body as { importRunId?: unknown }).importRunId;
  return typeof candidate === "string" && UUID_PATTERN.test(candidate)
    ? candidate
    : undefined;
}

/**
 * `payloadRef` for the error sample (issue #111): the raw-artifact R2 key
 * when the body carries one, otherwise a bounded JSON echo of the body.
 */
function derivePayloadRef(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const key = (body as { rawArtifactKey?: unknown }).rawArtifactKey;
    if (typeof key === "string" && key.length > 0) return key;
  }
  let echo: string;
  try {
    echo = JSON.stringify(body) ?? String(body);
  } catch {
    echo = String(body);
  }
  return echo.length > 2000 ? `${echo.slice(0, 2000)}…` : echo;
}

/**
 * Records a dead-lettered pipeline message: logs it, then persists it into
 * the owning import run's `error_samples` when the body names one. Callers
 * should treat it as fallible I/O — catch, log, and still ack, since a DLQ
 * consumer must never retry into a loop.
 */
export async function recordPipelineFailure(
  db: Db | Tx,
  failure: PipelineFailureRecord,
): Promise<void> {
  // Log first: the line must exist even if the database write fails.
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

  const importRunId = extractImportRunId(failure.body);
  if (importRunId === undefined) return;

  await appendImportRunError(db, importRunId, {
    stage: failure.stage,
    message: failure.errorMessage,
    payloadRef: derivePayloadRef(failure.body),
    occurredAt: failure.occurredAt.toISOString(),
  });
}
