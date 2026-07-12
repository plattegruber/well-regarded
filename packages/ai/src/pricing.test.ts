// Pricing math for the budget cap (issue #75) — estimates by design.
import { describe, expect, it } from "vitest";

import { estimateCostCents, FALLBACK_RATE, rateForModel } from "./pricing.js";

describe("rateForModel", () => {
  it("matches dated ids by family prefix", () => {
    expect(rateForModel("claude-haiku-4-5-20251001")).toEqual({
      inputCentsPerMTok: 100,
      outputCentsPerMTok: 500,
    });
    expect(rateForModel("claude-sonnet-5").inputCentsPerMTok).toBe(300);
  });

  it("falls back pessimistically for unknown models", () => {
    expect(rateForModel("gpt-oss-1")).toEqual(FALLBACK_RATE);
  });
});

describe("estimateCostCents", () => {
  it("prices input and output at their own rates", () => {
    // 1M in + 1M out on Haiku 4.5 = 100¢ + 500¢.
    expect(
      estimateCostCents("claude-haiku-4-5-20251001", 1_000_000, 1_000_000),
    ).toBe(600);
  });

  it("keeps fractional cents (sum first, round last)", () => {
    // 1k in + 200 out on Haiku: 0.1¢ + 0.1¢.
    expect(
      estimateCostCents("claude-haiku-4-5-20251001", 1_000, 200),
    ).toBeCloseTo(0.2, 10);
  });

  it("zero tokens cost zero", () => {
    expect(estimateCostCents("claude-haiku-4-5-20251001", 0, 0)).toBe(0);
  });
});
