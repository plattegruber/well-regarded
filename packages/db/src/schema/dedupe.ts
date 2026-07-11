/**
 * Dedupe-stage tables (issue #106, Epic #6): `signal_versions` and
 * `suspected_duplicates`.
 *
 * - `signal_versions` is the exact path's update policy. A `signals` row's
 *   original content is immutable (the `signals_protect_original` trigger,
 *   migration 0004), so an edited review — same `(practice_id, source_kind,
 *   source_id)` identity, changed content — is recorded as an append-only
 *   version row here, and the signal's `current_version_id` pointer moves.
 *   The patient's words as first captured are never rewritten; the latest
 *   version is what "current content" means from then on.
 *
 * - `suspected_duplicates` is the fuzzy path's output: a cross-source
 *   candidate pair (same practice, ±N-day window, same rating, embedding
 *   cosine similarity above threshold — constants in `@wellregarded/core`)
 *   linked for HUMAN review in the Signals inbox (Epic #11, #90). The
 *   epic's hard rule: **no silent merges** — both signals stay fully
 *   visible; this table only records the suspicion. Pairs are canonicalized
 *   (`signal_id_a < signal_id_b`, CHECK-enforced) and unique, so symmetric
 *   re-detection cannot duplicate rows.
 */

import { SUSPECTED_DUPLICATE_STATUSES } from "@wellregarded/core";
import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { signals } from "./signals.js";
import { practices } from "./tenancy.js";

export const signalVersions = pgTable(
  "signal_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    /** The edited text as re-imported; null for rating-only edits. */
    content: text("content"),
    /** Same representation as `signals.original_rating` (source's scale). */
    rating: numeric("rating", { precision: 2, scale: 1 }),
    /**
     * When the SOURCE says the edit happened (e.g. a Google review's update
     * time). Null when the source does not report one — today's
     * `NormalizedSignal` contract carries no update time, so the pipeline
     * writes null until an adapter (Epic #7/#8) supplies it.
     */
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // "Latest version" reads: the dedupe stage re-reads current content on
    // every conflict re-import, ordered by created_at.
    index("signal_versions_signal_id_created_at_idx").on(
      table.signalId,
      table.createdAt.desc(),
    ),
  ],
);

export const suspectedDuplicateStatusEnum = pgEnum(
  "suspected_duplicate_status",
  SUSPECTED_DUPLICATE_STATUSES,
);

export const suspectedDuplicates = pgTable(
  "suspected_duplicates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Denormalized for the inbox's practice-scoped listing (Epic #11). */
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    signalIdA: uuid("signal_id_a")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    signalIdB: uuid("signal_id_b")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    /** Embedding cosine similarity at detection time (1 = identical). */
    similarity: doublePrecision("similarity").notNull(),
    /** The pipeline only writes `pending_review`; #90's review flow resolves. */
    status: suspectedDuplicateStatusEnum("status")
      .notNull()
      .default("pending_review"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Canonical pair ordering + uniqueness: symmetric re-detection (B finds
    // A after A found B) lands on the same row, never a mirror duplicate.
    check(
      "suspected_duplicates_pair_ordered",
      sql`${table.signalIdA} < ${table.signalIdB}`,
    ),
    uniqueIndex("suspected_duplicates_pair_idx").on(
      table.signalIdA,
      table.signalIdB,
    ),
    // Inbox listing: pending links for a practice.
    index("suspected_duplicates_practice_id_status_idx").on(
      table.practiceId,
      table.status,
    ),
  ],
);
