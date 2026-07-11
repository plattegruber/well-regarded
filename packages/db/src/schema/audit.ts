/**
 * `audit_log` — the append-only compliance backbone (issue #46, Epic #3).
 *
 * Every consent change, publication, approval, patient-data access, and
 * deletion gets a row, and rows can never be altered or removed — enforced
 * by the database itself, not by code review: the
 * `audit_log_block_mutation()` BEFORE UPDATE OR DELETE trigger
 * (hand-written migration 0008) raises on any UPDATE or DELETE, with no
 * conditions and no carve-outs. TRUNCATE is not trigger-blockable per row,
 * so the same migration revokes it (`REVOKE TRUNCATE ... FROM PUBLIC`) and
 * it is never granted to the app role. If a future retention requirement
 * ever needs to purge audit rows, that is a deliberate migration under
 * Epic #23, not a code path.
 *
 * Writes go through `audit()` in `../audit.js` — explicit calls at
 * meaningful action boundaries (no CDC, no generic row triggers), inside
 * the same transaction as the mutation they record. Epic #23 builds its
 * review UI and retention tooling on top of this table.
 */

import { AUDIT_ACTOR_TYPES } from "@wellregarded/core";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { practices } from "./tenancy.js";

// Enum values sourced from @wellregarded/core (one source of truth; the
// `Actor` union consumed by `audit()` and Epic #4's auth surfaces uses the
// same constants).
export const auditActorTypeEnum = pgEnum("audit_actor_type", AUDIT_ACTOR_TYPES);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    actorType: auditActorTypeEnum("actor_type").notNull(),
    /**
     * Who, within the actor type: `staff_members.id` for `staff`; a
     * worker/job name for `system` (e.g. `pipeline:classify`); the token
     * `jti` for `patient_token`.
     */
    actorId: text("actor_id"),
    /**
     * Dot-namespaced `entity.verb`, e.g. `consent.granted`,
     * `consent.revoked`, `response.published`, `patient.viewed`,
     * `signal.redacted`. Free text — the convention is the contract, not an
     * enum: new actions must follow `entity.verb` so Epic #23's audit views
     * can group by prefix.
     */
    action: text("action").notNull(),
    /** The table name acted upon (e.g. `consents`). */
    entityType: text("entity_type").notNull(),
    /** The row id acted upon (text — not every entity id is a uuid). */
    entityId: text("entity_id").notNull(),
    /**
     * Before/after refs or minimal context. NEVER raw PII: store references
     * and non-PII fields only, e.g.
     * `{ "before": { "revoked_at": null }, "after": { "revoked_at": "..." } }`.
     */
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The two access patterns Epic #23's audit views need: a practice's
    // activity feed, and "everything that happened to this row".
    index("audit_log_practice_id_created_at_idx").on(
      table.practiceId,
      table.createdAt.desc(),
    ),
    index("audit_log_entity_type_entity_id_idx").on(
      table.entityType,
      table.entityId,
    ),
  ],
);
