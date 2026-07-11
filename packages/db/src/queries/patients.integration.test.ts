import { randomUUID } from "node:crypto";

import { decryptField } from "@wellregarded/core";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  consent,
  patient,
  practice,
  signal,
  TEST_KEYRING,
} from "../../test/factories.js";
import { pgError, setupTestDb } from "../../test/harness.js";
import { consents } from "../schema/consents.js";
import { contactPoints, patients } from "../schema/pii.js";
import { signals } from "../schema/signals.js";
import { findContactPoint, upsertContactPoint } from "./patients.js";

/**
 * Integration tests for pii.patients / pii.contact_points and the deferred
 * patient_id FKs (migration 0007, issue #47) against a real Postgres, on
 * the #49 harness (own database per file, factories for fixtures, no
 * cleanup needed). `upsertContactPoint` is exercised directly here — it is
 * the unit under test; the `contactPoint()` factory wraps the same helper
 * for other suites. Run locally with:
 *
 *   docker compose up -d && pnpm --filter @wellregarded/db test:integration
 */

const FOREIGN_KEY_VIOLATION = "23503";

// Test-only key material shared with the factories (never real secrets).
const keyring = TEST_KEYRING;

describe("pii.patients / pii.contact_points (integration)", () => {
  const t = setupTestDb();
  let practiceId: string;
  let otherPracticeId: string;

  beforeAll(async () => {
    practiceId = (await practice(t.db)).id;
    otherPracticeId = (await practice(t.db)).id;
  });

  it("upserts a contact point and finds it by raw value (differently formatted)", async () => {
    const pat = await patient(t.db, {
      practiceId,
      displayName: "Pat Example",
    });
    const created = await upsertContactPoint(t.db, {
      patientId: pat.id,
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
      t.db,
      practiceId,
      "sms",
      "+1 555.123.4567",
      keyring,
    );
    expect(found?.id).toBe(created.id);

    // Practice scoping: the same value under another practice finds nothing.
    const foreign = await findContactPoint(
      t.db,
      otherPracticeId,
      "sms",
      "(555) 123-4567",
      keyring,
    );
    expect(foreign).toBeUndefined();
  });

  it("returns the existing row on duplicate upsert (unique patient_id/kind/value_hash)", async () => {
    const pat = await patient(t.db, {
      practiceId,
      displayName: "Dupe Example",
    });
    const first = await upsertContactPoint(t.db, {
      patientId: pat.id,
      kind: "email",
      rawValue: "Dupe@Example.com",
      keyring,
    });
    // Same normalized value, different formatting → the existing row.
    const second = await upsertContactPoint(t.db, {
      patientId: pat.id,
      kind: "email",
      rawValue: "  dupe@example.COM ",
      keyring,
    });
    expect(second.id).toBe(first.id);

    const rows = await t.db
      .select()
      .from(contactPoints)
      .where(eq(contactPoints.patientId, pat.id));
    expect(rows).toHaveLength(1);
  });

  it("never stores the plaintext — value_encrypted is versioned ciphertext that still decrypts", async () => {
    const pat = await patient(t.db, {
      practiceId,
      displayName: "Cipher Example",
    });
    const rawValue = "cipher-roundtrip@example.com";
    const created = await upsertContactPoint(t.db, {
      patientId: pat.id,
      kind: "email",
      rawValue,
      keyring,
    });

    const [stored] = await t.db
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
    const { code } = await pgError(
      t.db.insert(signals).values({
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
    const pat = await patient(t.db, {
      practiceId,
      displayName: "Departing Example",
    });
    const contact = await upsertContactPoint(t.db, {
      patientId: pat.id,
      kind: "sms",
      rawValue: "555-000-1111",
      keyring,
    });
    const sig = await signal(t.db, {
      practiceId,
      patientId: pat.id,
      sourceKind: "firstparty",
      occurredAt: new Date("2026-06-02T00:00:00Z"),
      originalText: "Great visit.",
    });
    const granted = await consent(t.db, {
      practiceId,
      signalId: sig.id,
      patientId: pat.id,
      grantedAt: new Date("2026-06-03T00:00:00Z"),
    });

    // Deleting a patient must never destroy signals or consent history.
    await t.db.delete(patients).where(eq(patients.id, pat.id));

    const [signalAfter] = await t.db
      .select()
      .from(signals)
      .where(eq(signals.id, sig.id));
    expect(signalAfter?.patientId).toBeNull();
    expect(signalAfter?.originalText).toBe("Great visit.");

    const [consentAfter] = await t.db
      .select()
      .from(consents)
      .where(eq(consents.id, granted.id));
    expect(consentAfter?.patientId).toBeNull();
    expect(consentAfter?.revokedAt).toBeNull();

    // Contact points are identity, not history: they cascade away.
    const contacts = await t.db
      .select()
      .from(contactPoints)
      .where(eq(contactPoints.id, contact.id));
    expect(contacts).toHaveLength(0);
  });
});
