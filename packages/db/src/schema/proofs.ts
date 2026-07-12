/**
 * `proofs` + `placements` — governed reuse of signals (issue #96,
 * Epic #13).
 *
 * A **proof** is a governed decision to use a signal (or one of its
 * excerpts) beyond its source; a **placement** records where it is used.
 * Neither table carries any publishability state: eligibility to serve is
 * computed at read time by `publishableProofs` in `../queries/proofs.js`,
 * whose consent join encodes `checkConsent` (packages/db/CONSENT.md —
 * no `is_publishable` boolean, ever). `status = 'approved'` records a
 * human's editorial decision, not a right to publish.
 *
 * - `excerpt_id` NULL = a whole-signal proof; set = excerpt-level. The
 *   invariant "the excerpt belongs to the same signal" is a composite FK
 *   `(signal_id, excerpt_id) → proof_excerpts (signal_id, id)`, backed by
 *   a unique index on `proof_excerpts (signal_id, id)` — the simplest
 *   shape Drizzle supports (see migration 0024). MATCH SIMPLE semantics
 *   make the constraint vacuous when `excerpt_id` is NULL, which is
 *   exactly the whole-signal case.
 * - `display_text` is what gets published, initialized from the original
 *   at approval time (issue #105) and NULL on route-stage suggestions —
 *   the original text is referenced via `signal_id`/`excerpt_id`, never
 *   copied or mutated. Edits touch only this column; `proof_excerpts`
 *   stays a pristine extraction artifact.
 * - Idempotency (route stage, issue #108): the partial unique indexes
 *   below allow at most ONE non-archived proof per whole signal and per
 *   excerpt — queue re-delivery and re-classification can never stack
 *   suggestions; archiving frees the slot for a fresh one.
 */

import { PLACEMENT_CHANNELS, PROOF_STATUSES } from "@wellregarded/core";
import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { proofExcerpts } from "./proofExcerpts.js";
import { signals } from "./signals.js";
import { practices, staffMembers } from "./tenancy.js";

// Enum values sourced from @wellregarded/core (one source of truth; the
// same pattern as the consents enums).
export const proofStatusEnum = pgEnum("proof_status", PROOF_STATUSES);
export const placementChannelEnum = pgEnum(
  "placement_channel",
  PLACEMENT_CHANNELS,
);

export const proofs = pgTable(
  "proofs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    /** The signal whose words this proof reuses — the original reference. */
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id),
    /**
     * NULL = whole-signal proof; set = excerpt-level. Same-signal
     * integrity is the composite FK in the table extras (see module doc).
     */
    excerptId: uuid("excerpt_id"),
    /**
     * What gets published (see module doc): NULL until approval
     * initializes it from the original (#105); route suggestions never
     * set it.
     */
    displayText: text("display_text"),
    status: proofStatusEnum("status").notNull().default("suggested"),
    /** Who approved (staff), when — NULL while suggested/never approved. */
    approvedBy: uuid("approved_by").references(() => staffMembers.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Same-signal excerpt invariant (module doc).
    foreignKey({
      name: "proofs_signal_id_excerpt_id_fk",
      columns: [table.signalId, table.excerptId],
      foreignColumns: [proofExcerpts.signalId, proofExcerpts.id],
    }),
    // Route-stage idempotency backstop (module doc): one live whole-signal
    // proof per signal, one live proof per excerpt.
    uniqueIndex("proofs_signal_whole_live_uniq")
      .on(table.signalId)
      .where(sql`"excerpt_id" IS NULL AND "status" <> 'archived'`),
    uniqueIndex("proofs_signal_excerpt_live_uniq")
      .on(table.signalId, table.excerptId)
      .where(sql`"excerpt_id" IS NOT NULL AND "status" <> 'archived'`),
    // The proof library lists by practice + status; publishableProofs
    // filters `status = 'approved'` per practice.
    index("proofs_practice_id_status_idx").on(table.practiceId, table.status),
    index("proofs_signal_id_idx").on(table.signalId),
  ],
);

export const placements = pgTable(
  "placements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Denormalized from the proof — every table is practice-scoped. */
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    proofId: uuid("proof_id")
      .notNull()
      .references(() => proofs.id),
    channel: placementChannelEnum("channel").notNull(),
    /** Free-text hint, e.g. a page or topic ("invisalign landing page"). */
    target: text("target"),
    active: boolean("active").notNull().default(true),
    activatedAt: timestamp("activated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    /**
     * Why it came down: free text for staff reasons, or the machine-written
     * `PLACEMENT_DEACTIVATION_CONSENT_REVOKED` from @wellregarded/core when
     * a consent revocation cascades (issue #91).
     */
    deactivationReason: text("deactivation_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("placements_proof_id_idx").on(table.proofId),
    // "What is live where" — the placement surfaces list per practice.
    index("placements_practice_id_active_idx").on(
      table.practiceId,
      table.active,
    ),
  ],
);
