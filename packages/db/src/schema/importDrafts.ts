/**
 * `import_drafts` — the persisted pairing of an uploaded CSV and the
 * column mapping being edited for it (issue #133, Epic #8).
 *
 * One row per upload: where the file landed (`r2_key`, the
 * content-addressed `{practiceId}/imports/{sha256}.csv` key from
 * `@wellregarded/sources`), what it looked like (`original_filename`,
 * `byte_size`, parsed `headers`), and the `ColumnMapping` the wizard
 * (#134) saves onto it — nullable until the wizard's first save. The
 * import Workflow (#135) consumes a `confirmed` draft; re-uploading before
 * confirmation marks the older draft `superseded`.
 *
 * `headers` and `mapping` are jsonb, not child tables: both are small
 * (dozens of columns), read/written whole, and never queried per-element.
 * `mapping`'s shape is owned by `columnMappingSchema` in
 * `@wellregarded/core` — writers validate before persisting; the column
 * type only mirrors the inferred type.
 */

import { type ColumnMapping, IMPORT_DRAFT_STATUSES } from "@wellregarded/core";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { importRuns } from "./importRuns.js";
import { practices, staffMembers } from "./tenancy.js";

// Enum values sourced from @wellregarded/core (one source of truth, same
// pattern as the import_runs enums).
export const importDraftStatusEnum = pgEnum(
  "import_draft_status",
  IMPORT_DRAFT_STATUSES,
);

export const importDrafts = pgTable(
  "import_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),

    /** Content-addressed R2 key: `{practiceId}/imports/{sha256}.csv`. */
    r2Key: text("r2_key").notNull(),
    /** As the uploader named it — display only, never used as a path. */
    originalFilename: text("original_filename").notNull(),
    /** Exact stored size; the upload endpoint counted these bytes. */
    byteSize: integer("byte_size").notNull(),
    /** The parsed header row, in column order — what mappings validate against. */
    headers: jsonb("headers").$type<string[]>().notNull(),
    /**
     * The wizard's `ColumnMapping` (`@wellregarded/core`), null until its
     * first save. Always schema-validated before writing.
     */
    mapping: jsonb("mapping").$type<ColumnMapping>(),

    status: importDraftStatusEnum("status").notNull().default("draft"),

    /**
     * The `import_runs` row executing (or having executed) this draft —
     * set by the import Workflow's validate step (#135), null until then.
     * The queryable draft↔run linkage the report UI (#137) follows.
     */
    importRunId: uuid("import_run_id").references(() => importRuns.id),

    /** Who uploaded. Staff rows are deactivated, never deleted, so non-null holds. */
    createdBy: uuid("created_by")
      .notNull()
      .references(() => staffMembers.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Touched on every mapping save. */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Newest-first per practice — the "resume your import" listing.
    index("import_drafts_practice_id_created_at_idx").on(
      table.practiceId,
      table.createdAt.desc(),
    ),
  ],
);
