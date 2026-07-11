/**
 * Trust Signal vocabulary — the single source of truth for the `signals`
 * table's Postgres enums in `@wellregarded/db` (issue #35, Epic #3).
 *
 * Domain vocabulary lives here in core so the database schema and every
 * adapter/consumer share the same constants: one list, no drift. Adding a
 * value means appending here and generating a migration in `packages/db`
 * (Postgres enums are append-friendly; removal is a fix-forward migration).
 */

/** Where a signal came from — every source adapter normalizes into one of these. */
export const SOURCE_KINDS = [
  "google",
  "csv_import",
  "manual",
  "email",
  "firstparty",
  "opendental",
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * `public` = visible at the source (e.g. a Google review);
 * `private` = internal-only (e.g. direct feedback).
 */
export const SIGNAL_VISIBILITIES = ["public", "private"] as const;

export type SignalVisibility = (typeof SIGNAL_VISIBILITIES)[number];

/** Whether the signal still exists at its source. */
export const SIGNAL_AVAILABILITIES = [
  "available",
  "deleted_at_source",
] as const;

export type SignalAvailability = (typeof SIGNAL_AVAILABILITIES)[number];

/**
 * Compliance lifecycle state (Epic #23). Transitions to `redacted`/`purged`
 * are the only path that may null a signal's original content — see the
 * `signals_protect_original` trigger in `@wellregarded/db`.
 */
export const RETENTION_STATES = ["active", "redacted", "purged"] as const;

export type RetentionState = (typeof RETENTION_STATES)[number];

/**
 * Where a signal sits in the pipeline spine (Epic #6). The normalize stage
 * (#104) inserts rows as `pending_dedupe`; dedupe (#106) advances survivors
 * to `pending_classify`; classify (#67) to `pending_route`; route (#108)
 * lands them at `processed`, the terminal state every downstream surface
 * reads. Deliberately named "pipeline status": it records position in the
 * spine, never a derived judgment (those live in `derivations`).
 */
export const SIGNAL_PIPELINE_STATUSES = [
  "pending_dedupe",
  "pending_classify",
  "pending_route",
  "processed",
] as const;

export type SignalPipelineStatus = (typeof SIGNAL_PIPELINE_STATUSES)[number];
