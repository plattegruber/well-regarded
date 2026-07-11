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

/**
 * A patient contact hint carried by a `NormalizedSignal` (issue #104) —
 * mirrors `PatientHint` in `@wellregarded/sources` without importing it. At
 * least one of the fields is present (the source contract enforces that).
 */
export interface PatientContactHint {
  name?: string | undefined;
  email?: string | undefined;
  /** Mapped to contact kind `sms` (the phone-shaped `CONTACT_KINDS` value). */
  phone?: string | undefined;
}

/**
 * The pipeline's PII seam (issue #104 requirement 4): resolve a signal's
 * `patientHint` to a `pii.patients` row id, create-or-match by contact
 * point within the practice.
 *
 * Match: hash-equality lookup on email first, then phone — never a name
 * match (names are not identities). Miss: insert a patient (displayName
 * from the hint) and its contact points through `upsertContactPoint`, the
 * one sanctioned encrypt+hash write path. Callers link the returned id into
 * `signals.patient_id` inside the same transaction.
 */
export async function matchOrCreatePatientByContact(
  db: Db | Tx,
  input: {
    practiceId: string;
    hint: PatientContactHint;
    keyring: Keyring;
  },
): Promise<string> {
  const { practiceId, hint, keyring } = input;
  const contacts: Array<{ kind: ContactKind; rawValue: string }> = [];
  if (hint.email) contacts.push({ kind: "email", rawValue: hint.email });
  if (hint.phone) contacts.push({ kind: "sms", rawValue: hint.phone });

  for (const contact of contacts) {
    const existing = await findContactPoint(
      db,
      practiceId,
      contact.kind,
      contact.rawValue,
      keyring,
    );
    if (existing) return existing.patientId;
  }

  const [patient] = await db
    .insert(patients)
    .values({ practiceId, displayName: hint.name ?? null })
    .returning({ id: patients.id });
  if (!patient) {
    throw new Error("matchOrCreatePatientByContact: insert returned no row");
  }
  for (const contact of contacts) {
    await upsertContactPoint(db, {
      patientId: patient.id,
      kind: contact.kind,
      rawValue: contact.rawValue,
      keyring,
    });
  }
  return patient.id;
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
