/**
 * Monthly AI spend + practiceAiStatus (issue #75) against real Postgres:
 * the month window is the practice's OWN timezone, error rows count
 * (they cost money), and the 80/100 levels resolve through real settings
 * rows.
 */

import { describe, expect, it } from "vitest";

import { practice } from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import { aiCalls } from "../schema/aiCalls.js";
import { monthlyAiSpendCents, practiceAiStatus } from "./aiBudget.js";
import { updatePracticeAiSettings } from "./practiceSettings.js";

const t = setupTestDb();

/** Frozen "now": 2026-07-15 12:00Z (07:00 in America/Chicago). */
const NOW = new Date("2026-07-15T12:00:00Z");

const HAIKU = "claude-haiku-4-5-20251001";

const env = {
  PIPELINE_MODEL: HAIKU,
  DRAFTING_MODEL: "claude-sonnet-5",
};

async function seedCall(
  practiceId: string,
  createdAt: string,
  tokens: { input?: number; output?: number; error?: string | null } = {},
): Promise<void> {
  await t.db.insert(aiCalls).values({
    practiceId,
    purpose: "judgments",
    model: HAIKU,
    inputTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
    latencyMs: 500,
    error: tokens.error ?? null,
    createdAt: new Date(createdAt),
  });
}

describe("monthlyAiSpendCents", () => {
  it("sums this practice-local month only, error rows included", async () => {
    const p = await practice(t.db, { timezone: "America/Chicago" });
    // In the July window: 1M input (100¢) + a failed-validation call with
    // 1M output (500¢) — failures cost money too.
    await seedCall(p.id, "2026-07-05T15:00:00Z", { input: 1_000_000 });
    await seedCall(p.id, "2026-07-10T15:00:00Z", {
      output: 1_000_000,
      error: "zod validation mismatch",
    });
    // 2026-07-01T04:00Z is June 30 23:00 in Chicago — LAST month locally.
    await seedCall(p.id, "2026-07-01T04:00:00Z", { input: 5_000_000 });
    // Another practice's spend never bleeds in.
    const other = await practice(t.db, { timezone: "America/Chicago" });
    await seedCall(other.id, "2026-07-05T15:00:00Z", { input: 9_000_000 });

    expect(
      await monthlyAiSpendCents(t.db, { practiceId: p.id, now: NOW }),
    ).toBe(600);
  });

  it("returns 0 for a practice with no calls", async () => {
    const p = await practice(t.db);
    expect(
      await monthlyAiSpendCents(t.db, { practiceId: p.id, now: NOW }),
    ).toBe(0);
  });
});

describe("practiceAiStatus", () => {
  it("resolves the 80% and 100% levels against a practice budget", async () => {
    const p = await practice(t.db, { timezone: "America/Chicago" });
    await seedCall(p.id, "2026-07-05T15:00:00Z", { input: 1_000_000 }); // 100¢
    const actor = { type: "system", id: "test" } as const;

    // 100 / 125 = 80% exactly → soft.
    await updatePracticeAiSettings(t.db, {
      practiceId: p.id,
      settings: { monthlyBudgetCents: 125 },
      actor,
    });
    const soft = await practiceAiStatus(t.db, {
      practiceId: p.id,
      env,
      now: NOW,
    });
    expect(soft.spentCents).toBe(100);
    expect(soft.budget).toEqual({ level: "soft", ratio: 0.8 });
    expect(soft.config.disabled).toBe(false);

    // 100 / 100 → exhausted.
    await updatePracticeAiSettings(t.db, {
      practiceId: p.id,
      settings: { monthlyBudgetCents: 100 },
      actor,
    });
    const exhausted = await practiceAiStatus(t.db, {
      practiceId: p.id,
      env,
      now: NOW,
    });
    expect(exhausted.budget.level).toBe("exhausted");

    // Well under → ok.
    await updatePracticeAiSettings(t.db, {
      practiceId: p.id,
      settings: { monthlyBudgetCents: 10_000 },
      actor,
    });
    const ok = await practiceAiStatus(t.db, {
      practiceId: p.id,
      env,
      now: NOW,
    });
    expect(ok.budget.level).toBe("ok");
  });

  it("no settings row + no env cap → no budget, never disabled", async () => {
    const p = await practice(t.db);
    const status = await practiceAiStatus(t.db, {
      practiceId: p.id,
      env,
      now: NOW,
    });
    expect(status.settings).toBeNull();
    expect(status.config.monthlyBudgetCents).toBeNull();
    expect(status.budget).toEqual({ level: "ok", ratio: 0 });
  });

  it("practice disabled flag and env kill switch both disable", async () => {
    const p = await practice(t.db);
    await updatePracticeAiSettings(t.db, {
      practiceId: p.id,
      settings: { disabled: true },
      actor: { type: "system", id: "test" },
    });
    const byPractice = await practiceAiStatus(t.db, {
      practiceId: p.id,
      env,
      now: NOW,
    });
    expect(byPractice.config.disabled).toBe(true);

    const q = await practice(t.db);
    const byEnv = await practiceAiStatus(t.db, {
      practiceId: q.id,
      env: { ...env, AI_DISABLED: "true" },
      now: NOW,
    });
    expect(byEnv.config.disabled).toBe(true);
  });
});
