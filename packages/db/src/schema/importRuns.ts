/**
 * `import_runs` — provenance and observability for every batch, poll, and
 * webhook that feeds the pipeline (issue #111, Epic #6).
 *
 * One row per import run: who started it and how (`trigger`), what it
 * ingested (`source_kind`, `raw_artifact_keys`), how it went (the four
 * counts + `error_samples`), and whether it is still going (`status`,
 * `finished_at`). This is the epic's "failures visible, never silent"
 * spine: stage consumers update counts through the transactional helpers in
 * `../queries/importRuns.ts`, the DLQ consumer (#98) writes failures here
 * via `recordPipelineFailure`, and the import report UI (Epic #8) reads it
 * back through `getImportRunSummary`.
 *
 * Counts are integers updated with `SET x = x + $n` (never
 * read-modify-write); `error_samples` is a bounded jsonb array (cap
 * `IMPORT_RUN_ERROR_SAMPLE_CAP`, enforced in SQL) — the `failed` count is
 * the truth, samples are samples. `raw_artifact_keys` is jsonb rather than
 * a child table: volumes are small (a practice imports hundreds of rows,
 * not millions) and the keys are opaque R2 references (#100).
 */

import {
  IMPORT_RUN_STATUSES,
  IMPORT_RUN_TRIGGERS,
  type ImportRunErrorSample,
} from "@wellregarded/core";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { sourceKindEnum } from "./sourceKind.js";
import { practices } from "./tenancy.js";

// Enum values sourced from @wellregarded/core (one source of truth, same
// pattern as the signals enums).
export const importRunTriggerEnum = pgEnum(
  "import_run_trigger",
  IMPORT_RUN_TRIGGERS,
);
export const importRunStatusEnum = pgEnum(
  "import_run_status",
  IMPORT_RUN_STATUSES,
);

export const importRuns = pgTable(
  "import_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),

    sourceKind: sourceKindEnum("source_kind").notNull(),
    trigger: importRunTriggerEnum("trigger").notNull(),
    status: importRunStatusEnum("status").notNull().default("running"),

    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set by `finalizeImportRun` — null while the run is `running`. */
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    // Counts — updated via `incrementImportRunCounts` (`SET x = x + $n`
    // inside the calling stage's transaction, never read-modify-write).
    created: integer("created").notNull().default(0),
    merged: integer("merged").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    failed: integer("failed").notNull().default(0),

    /**
     * Per-stage extras (suspected_duplicates, route branch counters, ...)
     * — numeric values accumulated by `incrementImportRunCounts`'s
     * `statsPatch`.
     */
    stats: jsonb("stats")
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * Bounded array of failure samples (cap 100 in SQL — see
     * `appendImportRunError`); the `failed` count keeps counting past it.
     */
    errorSamples: jsonb("error_samples")
      .$type<ImportRunErrorSample[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** R2 keys of the raw artifacts (#100) this run stored. */
    rawArtifactKeys: jsonb("raw_artifact_keys")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (table) => [
    // `listImportRuns`: newest-first per practice, cursor on (started_at, id).
    index("import_runs_practice_id_started_at_idx").on(
      table.practiceId,
      table.startedAt.desc(),
    ),
  ],
);
