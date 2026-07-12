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
  type DerivationBasis,
  RETENTION_STATES,
  SIGNAL_AVAILABILITIES,
  SIGNAL_PIPELINE_STATUSES,
  SIGNAL_VISIBILITIES,
} from "@wellregarded/core";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

// Circular on purpose: signals points at its current version, versions point
// back at their signal. ESM handles the cycle because drizzle FK references
// are lazy callbacks (hence the `AnyPgColumn` annotation below).
import { signalVersions } from "./dedupe.js";
import { importRuns } from "./importRuns.js";
import { patients } from "./pii.js";
import { sourceKindEnum } from "./sourceKind.js";
import { locations, practices, providers } from "./tenancy.js";
import { tsvector } from "./tsvector.js";

/**
 * A provider/location hint the normalize stage (#104) could not confidently
 * resolve to an FK: the source's text plus how we know it (`basis` from the
 * shared `DERIVATION_BASES` vocabulary — `inferred_text` for text-derived
 * hints, `source_metadata` for structured ones, `manual` for staff-entered).
 * Mirrors `EntityHint` in `@wellregarded/sources` without importing it (that
 * package depends on this one for its drift guard).
 */
export interface SignalEntityHint {
  text: string;
  basis: DerivationBasis;
}

// Enum values sourced from @wellregarded/core (one source of truth; the
// source adapters in Epic #8 consume the same constants). `sourceKindEnum`
// lives in ./sourceKind.ts (shared with importRuns.ts without a cycle) and
// is re-exported here so import sites are unaffected.
export { sourceKindEnum } from "./sourceKind.js";
export const signalVisibilityEnum = pgEnum(
  "signal_visibility",
  SIGNAL_VISIBILITIES,
);
export const signalAvailabilityEnum = pgEnum(
  "signal_availability",
  SIGNAL_AVAILABILITIES,
);
export const retentionStateEnum = pgEnum("retention_state", RETENTION_STATES);
export const signalPipelineStatusEnum = pgEnum(
  "signal_pipeline_status",
  SIGNAL_PIPELINE_STATUSES,
);

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
    /** The `import_runs` row (#111) whose ingestion produced this signal. */
    importRunId: uuid("import_run_id").references(() => importRuns.id),

    // Unresolved entity hints from normalization (#104). A confident match
    // (exact case/whitespace-insensitive name, or a source-metadata ID
    // mapping) sets `provider_id`/`location_id` instead; anything fuzzier
    // stays here as text + basis — never a guessed FK.
    providerHint: jsonb("provider_hint").$type<SignalEntityHint>(),
    locationHint: jsonb("location_hint").$type<SignalEntityHint>(),

    // Original content — immutable; see signals_protect_original (module doc).
    originalText: text("original_text"),
    /**
     * On the source's own scale, e.g. `4.0` (Google 1–5); null for sources
     * without ratings. numeric(2,1) fits every rating system we ingest;
     * normalization to a common scale is adapter work (Epic #8), not schema.
     */
    originalRating: numeric("original_rating", { precision: 2, scale: 1 }),

    /**
     * Current-content pointer (issue #106): null means the original content
     * IS current; set when an edited re-import recorded a `signal_versions`
     * row (the original columns above stay untouched — see module doc).
     */
    currentVersionId: uuid("current_version_id").references(
      (): AnyPgColumn => signalVersions.id,
    ),

    /**
     * bge-m3 embedding of the signal's text (Workers AI `@cf/baai/bge-m3`,
     * Epic #9), written by the dedupe stage on first computation (#106) and
     * reused by classify/coverage instead of re-embedding. Null until then,
     * and always null for text-less signals.
     */
    embedding: vector("embedding", { dimensions: 1024 }),

    /**
     * Full-text index over `original_text` (issue #88): stored generated
     * column, so the inbox's FTS branch can never drift from the text.
     * Deliberately over the ORIGINAL text only — versions record edits, but
     * search finds the words as first captured (the immutable record).
     * Queried with `websearch_to_tsquery('english', ...)` by `listSignals`.
     */
    tsv: tsvector("tsv").generatedAlwaysAs(
      (): ReturnType<typeof sql> =>
        sql`to_tsvector('english', coalesce("original_text", ''))`,
    ),

    // State.
    /**
     * Position in the pipeline spine (Epic #6): normalize (#104) inserts
     * `pending_dedupe`; dedupe/classify/route advance it to `processed`.
     * Rows created outside the pipeline (manual entry, seed) are inserted
     * as `processed` directly. NOT a derived judgment — the module doc's
     * "no derived status" rule still holds; those live in `derivations`.
     */
    pipelineStatus: signalPipelineStatusEnum("pipeline_status")
      .notNull()
      .default("pending_dedupe"),
    visibility: signalVisibilityEnum("visibility").notNull(),
    availability: signalAvailabilityEnum("availability")
      .notNull()
      .default("available"),
    retentionState: retentionStateEnum("retention_state")
      .notNull()
      .default("active"),
    /**
     * AI-deferral marker (issue #75): set by the classify stage when the
     * kill switch (`AI_DISABLED` / `practice_settings.ai.disabled`) or the
     * monthly budget cap deferred classification — the signal keeps
     * flowing (route still runs; the inbox shows it honestly as "not yet
     * classified") and this timestamp is the re-drive set: once AI is
     * re-enabled, sweep `classification_deferred_at IS NOT NULL` back
     * through the classify queue (`listDeferredClassifications` in
     * ../queries/signals.ts; classify clears the marker on a successful
     * pass). NOT a pipeline status — the spine's position stays in
     * `pipeline_status`; this only records that judgments are owed.
     */
    classificationDeferredAt: timestamp("classification_deferred_at", {
      withTimezone: true,
    }),

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
    // Reverse lookup for the import report UI's drill-down (#111): all
    // signals produced by one run. Partial — most signals carry no run.
    index("signals_import_run_id_idx")
      .on(table.importRunId)
      .where(sql`${table.importRunId} IS NOT NULL`),
    // Fuzzy-duplicate candidate ANN (#106): cosine over signal embeddings,
    // practice/window predicates post-filtered during the HNSW scan.
    index("signals_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    // Inbox full-text search (#88). The FTS query is practice-scoped first;
    // plain GIN + the practice filter is fine at M1 volume. Future hook (do
    // not build now): a composite (practice_id, tsv) via btree_gin, or
    // practice-level partitioning, once a single practice's corpus makes
    // the post-filter hurt.
    index("signals_tsv_gin_idx").using("gin", table.tsv),
  ],
);
