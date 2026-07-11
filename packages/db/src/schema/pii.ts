/**
 * `pii.*` — patient identity, the HIPAA-shaped boundary (issue #47,
 * Epic #3).
 *
 * Patient identity lives in a separate Postgres schema (`pii`, created by
 * migration 0001), and contact values (phone/email) are encrypted at the
 * application layer before they ever reach the database — a leaked dump or
 * an overly-broad query never exposes raw contact data. We build this shape
 * now and sign BAAs at the first PHI customer.
 *
 * THE RULE: nothing outside `packages/db` and `packages/core` touches
 * `value_encrypted` or the keyring. Reads and writes go through the helpers
 * in `../queries/patients.js` (hash-based lookup, encrypt-on-write); API
 * responses that include contact info decrypt explicitly at the edge via
 * `decryptField` from `@wellregarded/core`, and every such access is
 * audited via `audit()` with action `patient.viewed`.
 *
 * `value_hash` is a deterministic HMAC (see `hashField` in
 * `@wellregarded/core`) so encrypted values are findable by equality
 * without decryption. Determinism leaks equality on purpose — that is the
 * dedupe/lookup property we want; see the fieldEncryption module doc before
 * "fixing" it.
 */

import { CONTACT_CONSENT_HINTS, CONTACT_KINDS } from "@wellregarded/core";
import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { practices } from "./tenancy.js";

/** The isolated `pii` Postgres schema (created by migration 0001). */
export const piiSchema = pgSchema("pii");

// Enum values sourced from @wellregarded/core (one source of truth). The
// enums live inside the pii schema alongside the tables they describe.
export const contactKindEnum = piiSchema.enum("contact_kind", CONTACT_KINDS);
export const contactConsentHintEnum = piiSchema.enum(
  "contact_consent_hint",
  CONTACT_CONSENT_HINTS,
);

export const patients = piiSchema.table(
  "patients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    /**
     * Source-system identifiers, e.g. `{ "opendental_pat_num": 123 }` —
     * jsonb so Epic #20 and future PMSs need no schema change.
     */
    externalRefs: jsonb("external_refs").notNull().default(sql`'{}'::jsonb`),
    /** May be a full name — it lives in `pii` on purpose. */
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("patients_practice_id_idx").on(table.practiceId)],
);

export const contactPoints = piiSchema.table(
  "contact_points",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    kind: contactKindEnum("kind").notNull(),
    /**
     * AES-256-GCM ciphertext, `v<n>:<iv_b64>:<ct_b64>` — see
     * `encryptField` in `@wellregarded/core`. Never queried by value; use
     * `value_hash`.
     */
    valueEncrypted: text("value_encrypted").notNull(),
    /** Deterministic HMAC-SHA256 (hex) of the normalized value. */
    valueHash: text("value_hash").notNull(),
    /**
     * What the source told us about contactability — a hint for Epic #19's
     * suppression checks, NOT publication consent (that is only ever the
     * `consents` table).
     */
    consentHint: contactConsentHintEnum("consent_hint")
      .notNull()
      .default("unknown"),
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("contact_points_value_hash_idx").on(table.valueHash),
    index("contact_points_patient_id_idx").on(table.patientId),
    // Prevents duplicate contact rows; `upsertContactPoint` relies on it
    // for insert-or-return-existing.
    uniqueIndex("contact_points_patient_id_kind_value_hash_idx").on(
      table.patientId,
      table.kind,
      table.valueHash,
    ),
  ],
);
