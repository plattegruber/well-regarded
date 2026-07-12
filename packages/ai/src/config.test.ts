// resolveAiConfig precedence + the 80/100 budget policy (issue #75).
import { describe, expect, it } from "vitest";

import {
  budgetState,
  practiceAiSettingsSchema,
  resolveAiConfig,
} from "./config.js";

const env = {
  PIPELINE_MODEL: "claude-haiku-4-5-20251001",
  DRAFTING_MODEL: "claude-sonnet-5",
};

describe("resolveAiConfig", () => {
  it("uses env defaults when the practice has no settings", () => {
    expect(resolveAiConfig(env, null)).toEqual({
      disabled: false,
      models: {
        pipeline: "claude-haiku-4-5-20251001",
        drafting: "claude-sonnet-5",
      },
      monthlyBudgetCents: null,
    });
  });

  it("practice overrides win over env (models + budget)", () => {
    const resolved = resolveAiConfig(
      { ...env, AI_MONTHLY_BUDGET_CENTS: 5_000 },
      {
        models: { pipeline: "claude-haiku-9" },
        monthlyBudgetCents: 12_000,
      },
    );
    expect(resolved.models.pipeline).toBe("claude-haiku-9");
    // Unset per-lane override falls through to env.
    expect(resolved.models.drafting).toBe("claude-sonnet-5");
    expect(resolved.monthlyBudgetCents).toBe(12_000);
  });

  it("env budget default applies when the practice sets none", () => {
    const resolved = resolveAiConfig(
      { ...env, AI_MONTHLY_BUDGET_CENTS: 5_000 },
      {},
    );
    expect(resolved.monthlyBudgetCents).toBe(5_000);
  });

  it("disabled is an OR: either side can switch AI off, neither back on", () => {
    expect(
      resolveAiConfig({ ...env, AI_DISABLED: "true" }, null).disabled,
    ).toBe(true);
    expect(resolveAiConfig({ ...env, AI_DISABLED: "1" }, null).disabled).toBe(
      true,
    );
    expect(resolveAiConfig(env, { disabled: true }).disabled).toBe(true);
    // A practice cannot re-enable past the global switch.
    expect(
      resolveAiConfig({ ...env, AI_DISABLED: "true" }, { disabled: false })
        .disabled,
    ).toBe(true);
    // Non-truthy env values do not disable.
    expect(
      resolveAiConfig({ ...env, AI_DISABLED: "false" }, null).disabled,
    ).toBe(false);
    expect(resolveAiConfig({ ...env, AI_DISABLED: "" }, null).disabled).toBe(
      false,
    );
  });
});

describe("budgetState (the 80/100 boundaries)", () => {
  it("no cap configured → ok forever", () => {
    expect(budgetState(1_000_000, null)).toEqual({ level: "ok", ratio: 0 });
  });

  it("under 80% → ok", () => {
    expect(budgetState(7_999, 10_000).level).toBe("ok");
    expect(budgetState(0, 10_000).level).toBe("ok");
  });

  it("exactly 80% → soft (boundary inclusive)", () => {
    expect(budgetState(8_000, 10_000)).toEqual({ level: "soft", ratio: 0.8 });
  });

  it("between 80% and 100% → soft", () => {
    expect(budgetState(9_999, 10_000).level).toBe("soft");
  });

  it("exactly 100% → exhausted (boundary inclusive)", () => {
    expect(budgetState(10_000, 10_000)).toEqual({
      level: "exhausted",
      ratio: 1,
    });
  });

  it("over 100% → exhausted", () => {
    expect(budgetState(15_000, 10_000).level).toBe("exhausted");
  });

  it("a zero cap means never call", () => {
    expect(budgetState(0, 0).level).toBe("exhausted");
  });
});

describe("practiceAiSettingsSchema", () => {
  it("accepts the full shape", () => {
    const parsed = practiceAiSettingsSchema.parse({
      disabled: true,
      models: { pipeline: "claude-haiku-9", drafting: "claude-sonnet-9" },
      monthlyBudgetCents: 2_500,
    });
    expect(parsed.disabled).toBe(true);
    expect(parsed.monthlyBudgetCents).toBe(2_500);
  });

  it("rejects a negative budget", () => {
    expect(
      practiceAiSettingsSchema.safeParse({ monthlyBudgetCents: -1 }).success,
    ).toBe(false);
  });

  it("accepts an empty object (all defaults)", () => {
    expect(practiceAiSettingsSchema.safeParse({}).success).toBe(true);
  });
});
