/**
 * Patient contact-point helpers (issue #47, Epic #3).
 *
 * THE RULE (see `../schema/pii.ts`): nothing outside `packages/db` and
 * `packages/core` touches `value_encrypted` or the keyring. These helpers
 * are the write path (encrypt + hash) and the lookup path (hash equality —
 * never decrypt-to-search) for `pii.contact_points`. API responses that
 * include contact info decrypt explicitly at the edge via `decryptField`,
 * and every such access is audited via `audit()` with action
 * `patient.viewed`.
 */

import {
  type ContactConsentHint,
  type ContactKind,
  encryptField,
  hashField,
  type Keyring,
} from "@wellregarded/core";
import { and, eq } from "drizzle-orm";

import type { Tx } from "../audit.js";
import type { Db } from "../client.js";
import { contactPoints, patients } from "../schema/pii.js";

/** A `pii.contact_points` row. */
export type ContactPoint = typeof contactPoints.$inferSelect;
/** A `pii.patients` row. */
export type Patient = typeof patients.$inferSelect;

/**
 * Find a contact point by its raw value, scoped to a practice.
 *
 * Hash-based equality lookup: the raw value is normalized and HMAC'd by
 * `hashField` (the single normalization point — writers and readers must
 * normalize identically) and matched against `value_hash`, joining through
 * `pii.patients` for the practice scope. Never decrypts to search.
 */
export async function findContactPoint(
  db: Db | Tx,
  practiceId: string,
  kind: ContactKind,
  rawValue: string,
  keyring: Keyring,
): Promise<ContactPoint | undefined> {
  const valueHash = await hashField(rawValue, keyring);
  const [row] = await db
    .select({ contactPoint: contactPoints })
    .from(contactPoints)
    .innerJoin(patients, eq(contactPoints.patientId, patients.id))
    .where(
      and(
        eq(patients.practiceId, practiceId),
        eq(contactPoints.kind, kind),
        eq(contactPoints.valueHash, valueHash),
      ),
    )
    .limit(1);
  return row?.contactPoint;
}

export interface UpsertContactPointInput {
  patientId: string;
  kind: ContactKind;
  /** The raw (plaintext) contact value — encrypted and hashed here. */
  rawValue: string;
  keyring: Keyring;
  consentHint?: ContactConsentHint;
}

/**
 * Encrypt + hash a contact value and insert it, or return the existing row
 * when the patient already has this exact (normalized) value for this kind
 * — insert-or-return-existing via the unique
 * `(patient_id, kind, value_hash)` constraint. The plaintext never reaches
 * the database.
 */
export async function upsertContactPoint(
  db: Db | Tx,
  input: UpsertContactPointInput,
): Promise<ContactPoint> {
  const [valueEncrypted, valueHash] = await Promise.all([
    encryptField(input.rawValue, input.keyring),
    hashField(input.rawValue, input.keyring),
  ]);

  const [inserted] = await db
    .insert(contactPoints)
    .values({
      patientId: input.patientId,
      kind: input.kind,
      valueEncrypted,
      valueHash,
      consentHint: input.consentHint ?? "unknown",
    })
    .onConflictDoNothing({
      target: [
        contactPoints.patientId,
        contactPoints.kind,
        contactPoints.valueHash,
      ],
    })
    .returning();
  if (inserted) return inserted;

  const [existing] = await db
    .select()
    .from(contactPoints)
    .where(
      and(
        eq(contactPoints.patientId, input.patientId),
        eq(contactPoints.kind, input.kind),
        eq(contactPoints.valueHash, valueHash),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error(
      "upsertContactPoint: conflict on insert but no existing row found",
    );
  }
  return existing;
}
