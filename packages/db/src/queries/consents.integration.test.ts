import { randomUUID } from "node:crypto";

import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type Db, type Sql } from "../client.js";
import { consents } from "../schema/consents.js";
import { signals } from "../schema/signals.js";
import { practices } from "../schema/tenancy.js";
import { grantConsent, isPublishable, revokeConsent } from "./consents.js";

/**
 * Integration tests for the consents table and publication gate
 * (migration 0006, issue #38) against a real Postgres.
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

const UNIQUE_VIOLATION = "23505";

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

describe("consents (integration)", () => {
  let db: Db;
  let sql: Sql;
  const runId = randomUUID().slice(0, 8);
  let practiceId: string;

  beforeAll(async () => {
    ({ db, sql } = createDb(connectionString));
    const [practice] = await db
      .insert(practices)
      .values({
        clerkOrgId: `org_${runId}_consents`,
        name: "Consents Test Practice",
        slug: `consents-test-${runId}`,
      })
      .returning();
    if (!practice) throw new Error("practice insert returned no row");
    practiceId = practice.id;
  });

  afterAll(async () => {
    await db.delete(consents).where(inArray(consents.practiceId, [practiceId]));
    await db.delete(signals).where(inArray(signals.practiceId, [practiceId]));
    await db.delete(practices).where(inArray(practices.id, [practiceId]));
    await sql?.end();
  });

  async function insertSignal() {
    const [signal] = await db
      .insert(signals)
      .values({
        practiceId,
        sourceKind: "firstparty",
        occurredAt: new Date("2026-05-01T00:00:00Z"),
        originalText: "Fixture signal for consents.",
        visibility: "private",
      })
      .returning();
    if (!signal) throw new Error("signal insert returned no row");
    return signal;
  }

  function grantInput(signalId: string) {
    return {
      practiceId,
      signalId,
      channels: ["website" as const],
      attribution: "first_name" as const,
      grantedAt: new Date("2026-05-02T00:00:00Z"),
      source: "patient_link" as const,
    };
  }

  it("grantConsent twice assigns versions 1 and 2", async () => {
    const signal = await insertSignal();
    const v1 = await grantConsent(db, grantInput(signal.id));
    expect(v1.consentVersion).toBe(1);
    expect(v1.allowMinorEdits).toBe(false);
    expect(v1.patientId).toBeNull();

    const v2 = await grantConsent(db, {
      ...grantInput(signal.id),
      channels: ["website", "gbp"],
    });
    expect(v2.consentVersion).toBe(2);
    expect(v2.channels).toEqual(["website", "gbp"]);
  });

  it("versions are per signal — a second signal starts back at 1", async () => {
    const [a, b] = await Promise.all([insertSignal(), insertSignal()]);
    await grantConsent(db, grantInput(a.id));
    const first = await grantConsent(db, grantInput(b.id));
    expect(first.consentVersion).toBe(1);
  });

  it("a version conflict surfaces as a unique violation (retryable, never mis-versioned)", async () => {
    const signal = await insertSignal();
    await grantConsent(db, grantInput(signal.id));

    // Simulate the losing side of a concurrent grant: same version inserted
    // directly, as if both transactions read max(consent_version) = 1.
    const code = await pgErrorCode(
      db.insert(consents).values({
        ...grantInput(signal.id),
        consentVersion: 2,
      }),
    );
    expect(code).toBe("no error thrown");
    const duplicate = await pgErrorCode(
      db.insert(consents).values({
        ...grantInput(signal.id),
        consentVersion: 2,
      }),
    );
    expect(duplicate).toBe(UNIQUE_VIOLATION);
  });

  it("isPublishable end-to-end: ok on the granted channel, wrong channel refused with a reason", async () => {
    const signal = await insertSignal();
    await grantConsent(db, {
      ...grantInput(signal.id),
      channels: ["website", "email"],
    });

    const ok = await isPublishable(db, signal.id, "website");
    expect(ok.publishable).toBe(true);
    expect(ok.reason).toBe("ok");
    expect(ok.consent?.attribution).toBe("first_name");

    const wrongChannel = await isPublishable(db, signal.id, "gbp");
    expect(wrongChannel.publishable).toBe(false);
    expect(wrongChannel.reason).toBe("channel_not_granted");
  });

  it("isPublishable end-to-end: revocation flips the decision to revoked", async () => {
    const signal = await insertSignal();
    await grantConsent(db, grantInput(signal.id));

    const revoked = await revokeConsent(
      db,
      signal.id,
      new Date("2026-05-03T00:00:00Z"),
    );
    expect(revoked?.consentVersion).toBe(1);
    expect(revoked?.revokedAt).toBeInstanceOf(Date);

    const decision = await isPublishable(db, signal.id, "website");
    expect(decision.publishable).toBe(false);
    expect(decision.reason).toBe("revoked");

    // Re-grant after revocation is a new row with a higher version — and
    // publishable again.
    const regrant = await grantConsent(db, grantInput(signal.id));
    expect(regrant.consentVersion).toBe(2);
    const after = await isPublishable(db, signal.id, "website");
    expect(after).toMatchObject({ publishable: true, reason: "ok" });
  });

  it("isPublishable reports no_consent for a signal with no rows", async () => {
    const signal = await insertSignal();
    const decision = await isPublishable(db, signal.id, "website");
    expect(decision).toEqual({ publishable: false, reason: "no_consent" });
  });

  it("revokeConsent returns undefined when there is nothing active to revoke", async () => {
    const signal = await insertSignal();
    const result = await revokeConsent(db, signal.id, new Date());
    expect(result).toBeUndefined();
  });
});
