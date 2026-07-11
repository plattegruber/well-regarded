/**
 * `import_runs` vocabulary (issue #111, Epic #6) — the single source of
 * truth for the provenance table's Postgres enums in `@wellregarded/db`,
 * following the same pattern as `./signals.ts`.
 *
 * Every batch, poll, and webhook that feeds the pipeline gets an
 * `import_runs` record; these constants name how a run started and how it
 * ended. The table shape and its transactional helpers live in
 * `packages/db` (`schema/importRuns.ts`, `queries/importRuns.ts`).
 */

/** How an import run was started. */
export const IMPORT_RUN_TRIGGERS = ["manual", "cron", "webhook"] as const;

export type ImportRunTrigger = (typeof IMPORT_RUN_TRIGGERS)[number];

/**
 * Lifecycle of a run. `running` until the run's owner (the CSV Workflow in
 * Epic #8, the GBP poller in Epic #7) calls `finalizeImportRun`, which
 * derives one of the three terminal states from the counts:
 *
 * - `failed` — failures and zero successes;
 * - `completed_with_errors` — successes and failures mixed;
 * - `completed` — no failures.
 */
export const IMPORT_RUN_STATUSES = [
  "running",
  "completed",
  "completed_with_errors",
  "failed",
] as const;

export type ImportRunStatus = (typeof IMPORT_RUN_STATUSES)[number];

/**
 * Cap on the `error_samples` jsonb array — enforced in SQL by
 * `recordPipelineFailure`/`appendImportRunError`. The `failed` count is the
 * truth; samples are samples (issue #111 implementation note).
 */
export const IMPORT_RUN_ERROR_SAMPLE_CAP = 100;

/**
 * One entry in an import run's `error_samples` jsonb array. `payloadRef` is
 * a raw-artifact R2 key when the failing message carried one, otherwise a
 * JSON echo of the queue-message body — enough to answer "what happened to
 * my import?" without leaving the row.
 */
export interface ImportRunErrorSample {
  /** Pipeline stage the failure surfaced in (`ingest`, `dedupe`, ...). */
  stage: string;
  message: string;
  payloadRef: string;
  /** ISO datetime the failure was recorded. */
  occurredAt: string;
}
