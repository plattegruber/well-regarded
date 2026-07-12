/**
 * `import_drafts` vocabulary (issue #133, Epic #8) — the single source of
 * truth for the draft table's Postgres enum in `@wellregarded/db`, same
 * pattern as `../importRuns.ts`.
 *
 * A draft is the persisted pairing of an uploaded CSV (its R2 key +
 * parsed headers) with the `ColumnMapping` the wizard (#134) edits:
 *
 * - `draft`      — uploaded; mapping absent or still being edited.
 * - `confirmed`  — the wizard's final step locked the mapping; the import
 *                  Workflow (#135) consumes exactly this state.
 * - `superseded` — replaced by a newer upload before being confirmed;
 *                  never executed. Terminal.
 */
export const IMPORT_DRAFT_STATUSES = [
  "draft",
  "confirmed",
  "superseded",
] as const;

export type ImportDraftStatus = (typeof IMPORT_DRAFT_STATUSES)[number];

/**
 * The mapping wizard's four steps (issue #134), in walking order. The
 * draft row remembers the furthest step reached (`wizard_step`) so a
 * closed tab resumes where the office manager left off — never client-only
 * state.
 */
export const IMPORT_WIZARD_STEPS = [
  "map",
  "validate",
  "consent",
  "confirm",
] as const;

export type ImportWizardStep = (typeof IMPORT_WIZARD_STEPS)[number];

/**
 * Hard cap on an uploaded CSV, enforced by the upload endpoint via both
 * the `Content-Length` header and a streamed byte counter. 50MB is far
 * beyond any realistic review export (hundreds of thousands of rows) and
 * comfortably below both the Workers 128MB isolate memory limit and the
 * platform's per-request body limits (100MB on Free/Pro plans — see the
 * route module doc in `workers/api/src/routes/imports.ts`).
 */
export const CSV_IMPORT_MAX_BYTES = 50 * 1024 * 1024;
