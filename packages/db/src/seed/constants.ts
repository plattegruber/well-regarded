/**
 * Fixed constants for the demo-practice seed (issue #32, Epic #1).
 *
 * SEED CONTRACT: this dataset is the fixture contract for Playwright E2E
 * (Epic #25). Changing anything the seed produces — counts, texts, keys,
 * IDs — is a breaking change for E2E. Bump `SEED_VERSION` whenever the
 * dataset changes and call it out in the PR description.
 */

/**
 * Version of the demo dataset. Bump on ANY change to what the seed
 * produces; mention the bump in the PR description (see module doc).
 *
 * v2 (issue #111): the promised `import_runs` row now exists — the seed
 * creates the legacy CSV run (`DEMO_IMPORT_RUN_KEY`) that the `csv_import`
 * signals reference (the FK is real as of migration 0011), and every
 * seeded signal carries `status = 'processed'`.
 */
export const SEED_VERSION = 2;

/**
 * Fixed faker seed (issue #32 requirement 2). Narrative content is
 * hand-committed fixture data (see `./fixtures/`); faker fills only
 * incidental values (e.g. patient external refs), so runs are reproducible
 * as long as the pinned `@faker-js/faker` major does not change.
 */
export const SEED_FAKER_SEED = 32;

/**
 * The hardcoded time anchor every seeded timestamp is computed from —
 * never `new Date()`. "Thursday, July 10" is the screen date in the
 * designer's mockup (design/README.md); 17:00 UTC = noon in the practice's
 * `America/Chicago` timezone.
 */
export const SEED_ANCHOR = new Date("2026-07-10T17:00:00Z");

export const DAY_MS = 24 * 60 * 60 * 1000;

/** `SEED_ANCHOR` minus whole days (plus an optional hour offset). */
export function daysBeforeAnchor(days: number, hours = 0): Date {
  return new Date(SEED_ANCHOR.getTime() - days * DAY_MS + hours * 3600_000);
}

/**
 * Natural keys of the demo practice — the wipe step finds any previous
 * seed run through `clerk_org_id`, so these must stay stable across seed
 * versions.
 */
export const DEMO_PRACTICE_CLERK_ORG_ID = "org_demo_cedar_ridge";
export const DEMO_PRACTICE_SLUG = "cedar-ridge-dental";

/**
 * Provenance for the CSV-sourced signals. Since issue #111 (Epic #6)
 * landed the `import_runs` table and the `signals.import_run_id` FK, the
 * seed creates the run row itself (a completed manual legacy import) and
 * stamps its deterministic id on every `csv_import` signal.
 */
export const DEMO_IMPORT_RUN_KEY = "import-run:legacy-feedback-2025-11-03";
export const DEMO_IMPORT_ARTIFACT_KEY =
  "imports/demo/legacy-feedback-2025-11-03.csv";

/**
 * The legacy export was imported on 2025-11-03 — 249 days before the
 * anchor (see `DEMO_IMPORT_ARTIFACT_KEY`). Shared by the run row's
 * timestamps and the CSV signals' `created_at`.
 */
export const DEMO_IMPORT_DAYS_AGO = 249;
