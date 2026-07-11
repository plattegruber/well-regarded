import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { practice } from "../test/factories.js";
import { pgError, setupTestDb } from "../test/harness.js";
import { audit } from "./audit.js";
import { auditLog } from "./schema/audit.js";

/**
 * Integration tests for audit_log (migrations 0007 + 0008, issue #46)
 * against a real Postgres, on the #49 harness. The harness is what makes
 * this suite clean up after itself at all: audit rows are append-only by
 * design (the very property under test), so no afterAll could ever delete
 * them — instead the whole per-file database is dropped. Run locally with:
 *
 *   docker compose up -d && pnpm --filter @wellregarded/db test:integration
 */

/** RAISE EXCEPTION in a plpgsql trigger without an explicit ERRCODE. */
const RAISE_EXCEPTION = "P0001";

describe("audit_log (integration)", () => {
  const t = setupTestDb();
  let practiceId: string;

  beforeAll(async () => {
    practiceId = (await practice(t.db)).id;
  });

  it("audit() inserts a readable row for a staff actor", async () => {
    const entityId = randomUUID();
    await audit(t.db, {
      practiceId,
      actor: { type: "staff", id: "11111111-1111-1111-1111-111111111111" },
      action: "consent.granted",
      entityType: "consents",
      entityId,
      payload: { after: { channels: ["website"] } },
    });

    const [row] = await t.db
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
    await audit(t.db, {
      practiceId,
      actor: { type: "system", id: "pipeline:classify" },
      action: "signal.redacted",
      entityType: "signals",
      entityId,
    });

    const [row] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, entityId));
    expect(row?.actorType).toBe("system");
    expect(row?.actorId).toBe("pipeline:classify");
    expect(row?.payload).toBeNull();
  });

  it("audit() inserts a row for a patient_token actor (jti)", async () => {
    const entityId = randomUUID();
    await audit(t.db, {
      practiceId,
      actor: { type: "patient_token", jti: "jti_fixture" },
      action: "consent.granted",
      entityType: "consents",
      entityId,
    });

    const [row] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, entityId));
    expect(row?.actorType).toBe("patient_token");
    expect(row?.actorId).toBe("jti_fixture");
  });

  it("rejects UPDATE via the audit_log_block_mutation trigger", async () => {
    const entityId = randomUUID();
    await audit(t.db, {
      practiceId,
      actor: { type: "system", id: "test:immutability" },
      action: "response.published",
      entityType: "responses",
      entityId,
    });

    const { code, message } = await pgError(
      t.db
        .update(auditLog)
        .set({ action: "x" })
        .where(eq(auditLog.entityId, entityId)),
    );
    expect(code).toBe(RAISE_EXCEPTION);
    expect(message).toContain("audit_log is append-only");
  });

  it("rejects DELETE via the audit_log_block_mutation trigger", async () => {
    const entityId = randomUUID();
    await audit(t.db, {
      practiceId,
      actor: { type: "system", id: "test:immutability" },
      action: "patient.viewed",
      entityType: "patients",
      entityId,
    });

    const { code, message } = await pgError(
      t.db.delete(auditLog).where(eq(auditLog.entityId, entityId)),
    );
    expect(code).toBe(RAISE_EXCEPTION);
    expect(message).toContain("audit_log is append-only");

    // The row is still there.
    const rows = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, entityId));
    expect(rows).toHaveLength(1);
  });

  it("leaves no row when audit() runs inside a rolled-back transaction (same-transaction convention)", async () => {
    const entityId = randomUUID();
    await expect(
      t.db.transaction(async (tx) => {
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

    const rows = await t.db
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
