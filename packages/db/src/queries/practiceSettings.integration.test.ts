/**
 * practice_settings reads + the audited write path (issue #75): upsert
 * creates then overwrites, every change lands an audit_log row with
 * before/after, malformed blobs degrade to null on read.
 */

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { practice } from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import { auditLog } from "../schema/audit.js";
import { practiceSettings } from "../schema/practiceSettings.js";
import {
  getPracticeAiSettings,
  updatePracticeAiSettings,
} from "./practiceSettings.js";

const t = setupTestDb();

const ACTOR = {
  type: "staff",
  id: "8a9c1a52-6a54-4d43-9c39-9d5df2bb0e1a",
} as const;

describe("updatePracticeAiSettings", () => {
  it("creates the row on first write and audits with before: null", async () => {
    const p = await practice(t.db);
    await updatePracticeAiSettings(t.db, {
      practiceId: p.id,
      settings: { disabled: true, monthlyBudgetCents: 5_000 },
      actor: ACTOR,
    });

    expect(await getPracticeAiSettings(t.db, p.id)).toEqual({
      disabled: true,
      monthlyBudgetCents: 5_000,
    });

    const audits = await t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.practiceId, p.id),
          eq(auditLog.action, "practice.ai_settings_updated"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.payload).toEqual({
      before: null,
      after: { disabled: true, monthlyBudgetCents: 5_000 },
    });
    expect(audits[0]?.actorId).toBe(ACTOR.id);
  });

  it("upserts on second write and audits the transition", async () => {
    const p = await practice(t.db);
    await updatePracticeAiSettings(t.db, {
      practiceId: p.id,
      settings: { disabled: true },
      actor: ACTOR,
    });
    await updatePracticeAiSettings(t.db, {
      practiceId: p.id,
      settings: { disabled: false, monthlyBudgetCents: 2_500 },
      actor: ACTOR,
    });

    expect(await getPracticeAiSettings(t.db, p.id)).toEqual({
      disabled: false,
      monthlyBudgetCents: 2_500,
    });

    const audits = await t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.practiceId, p.id),
          eq(auditLog.action, "practice.ai_settings_updated"),
        ),
      )
      .orderBy(auditLog.createdAt);
    expect(audits).toHaveLength(2);
    expect(audits[1]?.payload).toMatchObject({
      before: { disabled: true },
      after: { disabled: false, monthlyBudgetCents: 2_500 },
    });
  });

  it("rejects invalid settings before touching the database", async () => {
    const p = await practice(t.db);
    await expect(
      updatePracticeAiSettings(t.db, {
        practiceId: p.id,
        settings: { monthlyBudgetCents: -100 },
        actor: ACTOR,
      }),
    ).rejects.toThrow();
    expect(await getPracticeAiSettings(t.db, p.id)).toBeNull();
  });
});

describe("getPracticeAiSettings", () => {
  it("returns null for a missing row", async () => {
    const p = await practice(t.db);
    expect(await getPracticeAiSettings(t.db, p.id)).toBeNull();
  });

  it("degrades a malformed blob to null instead of throwing", async () => {
    const p = await practice(t.db);
    await t.db.insert(practiceSettings).values({
      practiceId: p.id,
      // Bypasses the sanctioned write path on purpose (manual meddling).
      ai: { monthlyBudgetCents: "not a number" } as never,
    });
    expect(await getPracticeAiSettings(t.db, p.id)).toBeNull();
  });
});
