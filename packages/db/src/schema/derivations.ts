/**
 * `derivations` — judgments with confidence and basis (issue #36, Epic #3).
 *
 * Ethical invariant #1 lives here in the schema: an AI inference is never
 * presented as confirmed fact. Every judgment about a signal — sentiment,
 * urgency, response risk, publication suitability — is a row carrying
 * `confidence` and `basis`, so any UI or downstream job can (and must)
 * distinguish "a human said this" from "a model guessed this from text".
 *
 * Rows are append-only **by convention** (no trigger — the classify
 * pipeline in Epic #9 and the reclassify UI only ever insert). Judgments
 * are never updated in place; a new row supersedes the old, preserving the
 * full judgment history. There is deliberately no `updated_at` column: its
 * absence is the convention.
 *
 * Supersede semantics — the "current" derivation per (signal_id, dimension):
 *   1. any `basis = 'manual'` row beats any non-manual row, regardless of
 *      recency (a human correction must never be silently overridden by a
 *      newer model run);
 *   2. among rows of equal manual-ness, latest `created_at` wins.
 * Resolved by `getCurrentDerivations` / `getCurrentDerivationsForSignals`
 * in `../queries/derivations.js` — go through those, not ad-hoc queries.
 */

import { DERIVATION_BASES, DERIVATION_DIMENSIONS } from "@wellregarded/core";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { signals } from "./signals.js";
import { practices } from "./tenancy.js";

// Enum values sourced from @wellregarded/core (one source of truth; Epic #9
// writers and Epic #11 readers consume the same constants).
export const derivationDimensionEnum = pgEnum(
  "derivation_dimension",
  DERIVATION_DIMENSIONS,
);
export const derivationBasisEnum = pgEnum("derivation_basis", DERIVATION_BASES);

export const derivations = pgTable(
  "derivations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    /**
     * Denormalized for scoped queries, per the everything-carries-practice_id
     * rule.
     */
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    dimension: derivationDimensionEnum("dimension").notNull(),
    /**
     * Scalar judgments stored as JSON scalars (e.g. `"negative"`, `0.9`) —
     * jsonb so structured judgments like publication-suitability reasons
     * don't need a schema change.
     */
    value: jsonb("value").notNull(),
    confidence: real("confidence").notNull(),
    basis: derivationBasisEnum("basis").notNull(),
    /**
     * NULL for `manual`; required-by-convention for inferred bases (the AI
     * pipeline in Epic #9 always sets it).
     */
    modelVersion: text("model_version"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "derivations_confidence_range",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    // Serves getCurrentDerivations{,ForSignals} and the history view.
    index("derivations_signal_id_dimension_created_at_idx").on(
      table.signalId,
      table.dimension,
      table.createdAt.desc(),
    ),
  ],
);
