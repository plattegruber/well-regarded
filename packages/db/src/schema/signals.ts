/**
 * `signals` — the canonical Trust Signal (issue #35, Epic #3).
 *
 * The one table every source adapter normalizes into and every downstream
 * surface (inbox, reviews, recovery, proof) reads from. Two properties are
 * structural, not stylistic:
 *
 * - **Full provenance**: we can always say where a signal came from
 *   (`source_kind`/`source_id`/`source_url`) and point at the raw artifact
 *   in R2 (`raw_artifact_key`).
 * - **Immutability of original content**: `original_text` and
 *   `original_rating` are never rewritten. This is enforced at the database,
 *   not by convention: the `signals_protect_original` BEFORE UPDATE trigger
 *   (hand-written migration 0004) raises on any change to either column,
 *   with a single carve-out — transitions of `retention_state` to
 *   `redacted`/`purged` may null them (the Epic #23 compliance lifecycle
 *   needs this). Classification, editing, and consent all happen in other
 *   tables (`derivations`, `consents`) that reference this one.
 *
 * Deliberately absent: derived columns (sentiment, status, …) — that is
 * exactly what `derivations` exists for — and any publishability flag
 * (publication eligibility is only ever computed from `consents`; see
 * packages/db/CONSENT.md).
 */

import {
  RETENTION_STATES,
  SIGNAL_AVAILABILITIES,
  SIGNAL_VISIBILITIES,
  SOURCE_KINDS,
} from "@wellregarded/core";
import { sql } from "drizzle-orm";
import {
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { patients } from "./pii.js";
import { locations, practices, providers } from "./tenancy.js";

// Enum values sourced from @wellregarded/core (one source of truth; the
// source adapters in Epic #8 consume the same constants).
export const sourceKindEnum = pgEnum("source_kind", SOURCE_KINDS);
export const signalVisibilityEnum = pgEnum(
  "signal_visibility",
  SIGNAL_VISIBILITIES,
);
export const signalAvailabilityEnum = pgEnum(
  "signal_availability",
  SIGNAL_AVAILABILITIES,
);
export const retentionStateEnum = pgEnum("retention_state", RETENTION_STATES);

export const signals = pgTable(
  "signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),

    // Nullable associations.
    /**
     * FK to `pii.patients` (deferred from #35, added by #47). SET NULL on
     * patient delete — deleting a patient must never destroy signals.
     */
    patientId: uuid("patient_id").references(() => patients.id, {
      onDelete: "set null",
    }),
    locationId: uuid("location_id").references(() => locations.id),
    providerId: uuid("provider_id").references(() => providers.id),

    // Provenance.
    sourceKind: sourceKindEnum("source_kind").notNull(),
    /** The source's native ID (e.g. Google review name); null for manual entry. */
    sourceId: text("source_id"),
    sourceUrl: text("source_url"),
    /**
     * When the patient experience/review happened — not when we ingested it.
     */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** R2 key of the raw payload. */
    rawArtifactKey: text("raw_artifact_key"),
    /** No FK yet — `import_runs` lands in Epic #6; add the constraint there. */
    importRunId: uuid("import_run_id"),

    // Original content — immutable; see signals_protect_original (module doc).
    originalText: text("original_text"),
    /**
     * On the source's own scale, e.g. `4.0` (Google 1–5); null for sources
     * without ratings. numeric(2,1) fits every rating system we ingest;
     * normalization to a common scale is adapter work (Epic #8), not schema.
     */
    originalRating: numeric("original_rating", { precision: 2, scale: 1 }),

    // State.
    visibility: signalVisibilityEnum("visibility").notNull(),
    availability: signalAvailabilityEnum("availability")
      .notNull()
      .default("available"),
    retentionState: retentionStateEnum("retention_state")
      .notNull()
      .default("active"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Dedupe uniqueness — the pipeline's dedupe stage (Epic #6) relies on
    // this as its last line of defense: an exact re-import must fail at the
    // database, not just in application logic. Partial so manual signals
    // (null source_id) never collide.
    uniqueIndex("signals_practice_id_source_kind_source_id_idx")
      .on(table.practiceId, table.sourceKind, table.sourceId)
      .where(sql`${table.sourceId} IS NOT NULL`),
    // Inbox list queries: signals inbox (Epic #11) and review inbox (Epic #10).
    index("signals_practice_id_occurred_at_idx").on(
      table.practiceId,
      table.occurredAt.desc(),
    ),
    index("signals_practice_id_visibility_occurred_at_idx").on(
      table.practiceId,
      table.visibility,
      table.occurredAt.desc(),
    ),
  ],
);
