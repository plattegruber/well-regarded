import { randomUUID } from "node:crypto";

import { createKeyring, decryptField } from "@wellregarded/core";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type Db, type Sql } from "../client.js";
import { consents } from "../schema/consents.js";
import { contactPoints, patients } from "../schema/pii.js";
import { signals } from "../schema/signals.js";
import { practices } from "../schema/tenancy.js";
import { findContactPoint, upsertContactPoint } from "./patients.js";

/**
 * Integration tests for pii.patients / pii.contact_points and the deferred
 * patient_id FKs (migration 0007, issue #47) against a real Postgres.
 *
 * Run locally with:
 *
 *   docker compose up -d && pnpm db:migrate && \
 *     DATABASE_URL=postgres://... pnpm test:integration
 *
 * DATABASE_URL is asserted, never skipped (see CONTRIBUTING.md).
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL must be set to run integration tests " +
      "(local compose default: postgres://wellregarded:wellregarded@localhost:54322/wellregarded). " +
      "Integration tests never skip — a missing database is a failure.",
  );
}

const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Extract the Postgres error code. drizzle-orm wraps driver errors in
 * DrizzleQueryError with the PostgresError on `cause`, so check both.
 */
async function pgErrorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "";
  }
  return "no error thrown";
}

// Test-only key material (openssl rand -base64 32) — never real secrets.
const keyring = createKeyring({
  encryptionKeys: { "1": "3l4Zg1nkiYyIDvi2rL9BW6BpAgLE0za88AGB98s8xIo=" },
  hashKey: "H0M2t0Cyp0kWt3pWn4E2G9dY0aQx8bH4bBqkYb7t0eE=",
});

describe("pii.patients / pii.contact_points (integration)", () => {
  let db: Db;
  let sql: Sql;
  const runId = randomUUID().slice(0, 8);
  const practiceIds: string[] = [];
  let practiceId: string;
  let otherPracticeId: string;

  async function insertPractice(suffix: string) {
    const [practice] = await db
      .insert(practices)
      .values({
        clerkOrgId: `org_${runId}_${suffix}`,
        name: `PII Test Practice ${suffix}`,
        slug: `pii-test-${runId}-${suffix}`,
      })
      .returning();
    if (!practice) throw new Error("practice insert returned no row");
    practiceIds.push(practice.id);
    return practice.id;
  }

  async function insertPatient(pid: string, displayName: string) {
    const [patient] = await db
      .insert(patients)
      .values({ practiceId: pid, displayName })
      .returning();
    if (!patient) throw new Error("patient insert returned no row");
    return patient;
  }

  beforeAll(async () => {
    ({ db, sql } = createDb(connectionString));
    practiceId = await insertPractice("a");
    otherPracticeId = await insertPractice("b");
  });

  afterAll(async () => {
    // contact_points cascade with their patients.
    await db.delete(consents).where(inArray(consents.practiceId, practiceIds));
    await db.delete(signals).where(inArray(signals.practiceId, practiceIds));
    await db.delete(patients).where(inArray(patients.practiceId, practiceIds));
    await db.delete(practices).where(inArray(practices.id, practiceIds));
    await sql?.end();
  });

  it("upserts a contact point and finds it by raw value (differently formatted)", async () => {
    const patient = await insertPatient(practiceId, "Pat Example");
    const created = await upsertContactPoint(db, {
      patientId: patient.id,
      kind: "sms",
      rawValue: "(555) 123-4567",
      keyring,
      consentHint: "implied",
    });
    expect(created.consentHint).toBe("implied");
    expect(created.valueHash).toMatch(/^[0-9a-f]{64}$/);

    // Lookup normalizes identically, so a differently formatted raw value
    // finds the same row — without any decryption.
    const found = await findContactPoint(
      db,
      practiceId,
      "sms",
      "+1 555.123.4567",
      keyring,
    );
    expect(found?.id).toBe(created.id);

    // Practice scoping: the same value under another practice finds nothing.
    const foreign = await findContactPoint(
      db,
      otherPracticeId,
      "sms",
      "(555) 123-4567",
      keyring,
    );
    expect(foreign).toBeUndefined();
  });

  it("returns the existing row on duplicate upsert (unique patient_id/kind/value_hash)", async () => {
    const patient = await insertPatient(practiceId, "Dupe Example");
    const first = await upsertContactPoint(db, {
      patientId: patient.id,
      kind: "email",
      rawValue: "Dupe@Example.com",
      keyring,
    });
    // Same normalized value, different formatting → the existing row.
    const second = await upsertContactPoint(db, {
      patientId: patient.id,
      kind: "email",
      rawValue: "  dupe@example.COM ",
      keyring,
    });
    expect(second.id).toBe(first.id);

    const rows = await db
      .select()
      .from(contactPoints)
      .where(eq(contactPoints.patientId, patient.id));
    expect(rows).toHaveLength(1);
  });

  it("never stores the plaintext — value_encrypted is versioned ciphertext that still decrypts", async () => {
    const patient = await insertPatient(practiceId, "Cipher Example");
    const rawValue = `cipher-${runId}@example.com`;
    const created = await upsertContactPoint(db, {
      patientId: patient.id,
      kind: "email",
      rawValue,
      keyring,
    });

    const [stored] = await db
      .select({ valueEncrypted: contactPoints.valueEncrypted })
      .from(contactPoints)
      .where(eq(contactPoints.id, created.id));
    if (!stored) throw new Error("contact point not found");
    expect(stored.valueEncrypted).not.toContain(rawValue);
    expect(stored.valueEncrypted).not.toContain("example.com");
    expect(stored.valueEncrypted).toMatch(/^v1:/);
    await expect(decryptField(stored.valueEncrypted, keyring)).resolves.toBe(
      rawValue,
    );
  });

  it("enforces the deferred signals.patient_id FK", async () => {
    const code = await pgErrorCode(
      db.insert(signals).values({
        practiceId,
        patientId: randomUUID(), // no such patient
        sourceKind: "manual",
        occurredAt: new Date("2026-06-01T00:00:00Z"),
        visibility: "private",
      }),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("SET NULLs signals.patient_id and consents.patient_id on patient delete (and cascades contact points)", async () => {
    const patient = await insertPatient(practiceId, "Departing Example");
    const contact = await upsertContactPoint(db, {
      patientId: patient.id,
      kind: "sms",
      rawValue: "555-000-1111",
      keyring,
    });
    const [signal] = await db
      .insert(signals)
      .values({
        practiceId,
        patientId: patient.id,
        sourceKind: "firstparty",
        occurredAt: new Date("2026-06-02T00:00:00Z"),
        originalText: "Great visit.",
        visibility: "private",
      })
      .returning();
    if (!signal) throw new Error("signal insert returned no row");
    const [consent] = await db
      .insert(consents)
      .values({
        practiceId,
        signalId: signal.id,
        patientId: patient.id,
        channels: ["website"],
        attribution: "first_name",
        grantedAt: new Date("2026-06-03T00:00:00Z"),
        source: "patient_link",
        consentVersion: 1,
      })
      .returning();
    if (!consent) throw new Error("consent insert returned no row");

    // Deleting a patient must never destroy signals or consent history.
    await db.delete(patients).where(eq(patients.id, patient.id));

    const [signalAfter] = await db
      .select()
      .from(signals)
      .where(eq(signals.id, signal.id));
    expect(signalAfter?.patientId).toBeNull();
    expect(signalAfter?.originalText).toBe("Great visit.");

    const [consentAfter] = await db
      .select()
      .from(consents)
      .where(eq(consents.id, consent.id));
    expect(consentAfter?.patientId).toBeNull();
    expect(consentAfter?.revokedAt).toBeNull();

    // Contact points are identity, not history: they cascade away.
    const contacts = await db
      .select()
      .from(contactPoints)
      .where(eq(contactPoints.id, contact.id));
    expect(contacts).toHaveLength(0);
  });
});
