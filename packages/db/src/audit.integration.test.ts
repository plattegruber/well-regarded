import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { audit } from "./audit.js";
import { createDb, type Db, type Sql } from "./client.js";
import { auditLog } from "./schema/audit.js";
import { practices } from "./schema/tenancy.js";

/**
 * Integration tests for audit_log (migrations 0007 + 0008, issue #46)
 * against a real Postgres.
 *
 * Run locally with:
 *
 *   docker compose up -d && pnpm db:migrate && \
 *     DATABASE_URL=postgres://... pnpm test:integration
 *
 * DATABASE_URL is asserted, never skipped (see CONTRIBUTING.md).
 *
 * No cleanup on purpose: audit rows are append-only by design (the very
 * property under test), so this suite cannot delete what it writes — and
 * the fixture practice cannot be deleted either (audit rows reference it).
 * Rows are runId-suffixed; the CI database is ephemeral and the local
 * compose database tolerates leftover fixtures.
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL must be set to run integration tests " +
      "(local compose default: postgres://wellregarded:wellregarded@localhost:54322/wellregarded). " +
      "Integration tests never skip — a missing database is a failure.",
  );
}

/** RAISE EXCEPTION in a plpgsql trigger without an explicit ERRCODE. */
const RAISE_EXCEPTION = "P0001";

/**
 * Extract the Postgres error code/message. drizzle-orm wraps driver errors
 * in DrizzleQueryError with the PostgresError on `cause`, so check both.
 */
async function pgError(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    const e = error as {
      code?: string;
      message?: string;
      cause?: { code?: string; message?: string };
    };
    return {
      code: e.code ?? e.cause?.code ?? "",
      message: [e.message, e.cause?.message].filter(Boolean).join(" | "),
    };
  }
  return { code: "no error thrown", message: "" };
}

describe("audit_log (integration)", () => {
  let db: Db;
  let sql: Sql;
  const runId = randomUUID().slice(0, 8);
  let practiceId: string;

  beforeAll(async () => {
    ({ db, sql } = createDb(connectionString));
    const [practice] = await db
      .insert(practices)
      .values({
        clerkOrgId: `org_${runId}_audit`,
        name: "Audit Test Practice",
        slug: `audit-test-${runId}`,
      })
      .returning();
    if (!practice) throw new Error("practice insert returned no row");
    practiceId = practice.id;
    return async () => {
      await sql?.end();
    };
  });

  it("audit() inserts a readable row for a staff actor", async () => {
    const entityId = randomUUID();
    await audit(db, {
      practiceId,
      actor: { type: "staff", id: "11111111-1111-1111-1111-111111111111" },
      action: "consent.granted",
      entityType: "consents",
      entityId,
      payload: { after: { channels: ["website"] } },
    });

    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, entityId));
    expect(row?.practiceId).toBe(practiceId);
    expect(row?.actorType).toBe("staff");
    expect(row?.actorId).toBe("11111111-1111-1111-1111-111111111111");
    expect(row?.action).toBe("consent.granted");
    expect(row?.entityType).toBe("consents");
    expect(row?.payload).toEqual({ after: { channels: ["website"] } });
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it("audit() inserts a row for a system actor (worker/job name)", async () => {
    const entityId = randomUUID();
    await audit(db, {
      practiceId,
      actor: { type: "system", id: "pipeline:classify" },
      action: "signal.redacted",
      entityType: "signals",
      entityId,
    });

    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, entityId));
    expect(row?.actorType).toBe("system");
    expect(row?.actorId).toBe("pipeline:classify");
    expect(row?.payload).toBeNull();
  });

  it("audit() inserts a row for a patient_token actor (jti)", async () => {
    const entityId = randomUUID();
    await audit(db, {
      practiceId,
      actor: { type: "patient_token", jti: `jti_${runId}` },
      action: "consent.granted",
      entityType: "consents",
      entityId,
    });

    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, entityId));
    expect(row?.actorType).toBe("patient_token");
    expect(row?.actorId).toBe(`jti_${runId}`);
  });

  it("rejects UPDATE via the audit_log_block_mutation trigger", async () => {
    const entityId = randomUUID();
    await audit(db, {
      practiceId,
      actor: { type: "system", id: "test:immutability" },
      action: "response.published",
      entityType: "responses",
      entityId,
    });

    const { code, message } = await pgError(
      db
        .update(auditLog)
        .set({ action: "x" })
        .where(eq(auditLog.entityId, entityId)),
    );
    expect(code).toBe(RAISE_EXCEPTION);
    expect(message).toContain("audit_log is append-only");
  });

  it("rejects DELETE via the audit_log_block_mutation trigger", async () => {
    const entityId = randomUUID();
    await audit(db, {
      practiceId,
      actor: { type: "system", id: "test:immutability" },
      action: "patient.viewed",
      entityType: "patients",
      entityId,
    });

    const { code, message } = await pgError(
      db.delete(auditLog).where(eq(auditLog.entityId, entityId)),
    );
    expect(code).toBe(RAISE_EXCEPTION);
    expect(message).toContain("audit_log is append-only");

    // The row is still there.
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, entityId));
    expect(rows).toHaveLength(1);
  });

  it("leaves no row when audit() runs inside a rolled-back transaction (same-transaction convention)", async () => {
    const entityId = randomUUID();
    await expect(
      db.transaction(async (tx) => {
        await audit(tx, {
          practiceId,
          actor: { type: "staff", id: "22222222-2222-2222-2222-222222222222" },
          action: "consent.revoked",
          entityType: "consents",
          entityId,
        });
        // The mutation this audit row belongs to fails → both roll back.
        throw new Error("simulated mutation failure");
      }),
    ).rejects.toThrow("simulated mutation failure");

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityId, entityId),
          eq(auditLog.practiceId, practiceId),
        ),
      );
    expect(rows).toHaveLength(0);
  });
});
