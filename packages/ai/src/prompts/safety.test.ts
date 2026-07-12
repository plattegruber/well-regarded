import { describe, expect, it } from "vitest";

import {
  SAFETY_LLM_CATEGORIES,
  SAFETY_PROMPT_NAME,
  type SafetyJudgment,
  SafetyJudgmentSchema,
  safetyPrompt,
} from "./safety.js";

const judgment = (
  overrides: Partial<SafetyJudgment["findings"][number]> = {},
): SafetyJudgment => ({
  findings: [
    {
      category: "confirms_care_relationship",
      quote: "having you as a patient",
      reason: "Confirms the reviewer was a patient.",
      suggestion: "Thank them without referencing their care.",
      ...overrides,
    },
  ],
});

describe("SafetyJudgmentSchema", () => {
  it("accepts a well-formed judgment, including empty findings", () => {
    expect(SafetyJudgmentSchema.parse(judgment())).toEqual(judgment());
    expect(SafetyJudgmentSchema.parse({ findings: [] })).toEqual({
      findings: [],
    });
  });

  it("accepts null quote (whole-draft finding) and null suggestion", () => {
    const parsed = SafetyJudgmentSchema.parse(
      judgment({ quote: null, suggestion: null }),
    );
    expect(parsed.findings[0]?.quote).toBeNull();
    expect(parsed.findings[0]?.suggestion).toBeNull();
  });

  it("rejects categories outside the vocabulary", () => {
    expect(
      SafetyJudgmentSchema.safeParse(
        judgment({ category: "mentions_weather" as never }),
      ).success,
    ).toBe(false);
  });

  it("rejects over-long quotes/reasons and more than 8 findings", () => {
    expect(
      SafetyJudgmentSchema.safeParse(judgment({ quote: "x".repeat(301) }))
        .success,
    ).toBe(false);
    expect(
      SafetyJudgmentSchema.safeParse(judgment({ reason: "x".repeat(241) }))
        .success,
    ).toBe(false);
    const crowd = {
      findings: Array.from({ length: 9 }, () => judgment().findings[0]),
    };
    expect(SafetyJudgmentSchema.safeParse(crowd).success).toBe(false);
  });

  it("covers exactly the four subtle categories", () => {
    expect(SAFETY_LLM_CATEGORIES).toEqual([
      "confirms_care_relationship",
      "contradicts_reviewer_privately",
      "defensive_tone",
      "invites_public_dispute",
    ]);
  });
});

describe("safetyPrompt", () => {
  const input = {
    draft: "We're sorry to hear this — please call our office.",
    review: {
      text: "Waited an hour past my appointment time.",
      rating: "2.0",
      visibility: "public" as const,
    },
  };

  it("uses the stable prompt name — the FakeAiProvider fixture key", () => {
    expect(safetyPrompt(input).name).toBe(SAFETY_PROMPT_NAME);
    // Never interpolate per-call data into the name.
    expect(
      safetyPrompt({
        draft: "other draft",
        review: { text: null, rating: null, visibility: "private" },
      }).name,
    ).toBe(SAFETY_PROMPT_NAME);
  });

  it("carries the draft, review text, rating, and visibility in the user turn", () => {
    const prompt = safetyPrompt(input);
    expect(prompt.user).toContain(input.draft);
    expect(prompt.user).toContain("Waited an hour past my appointment time.");
    expect(prompt.user).toContain("rating: 2.0 out of 5");
    expect(prompt.user).toContain("visibility: public");
  });

  it("renders a rating-only review explicitly", () => {
    const prompt = safetyPrompt({
      draft: "Thanks!",
      review: { text: "  ", rating: null, visibility: "public" },
    });
    expect(prompt.user).toContain("rating: none");
    expect(prompt.user).toContain("(none)");
  });

  it("system prompt encodes the safe-response principles", () => {
    const system = safetyPrompt(input).system ?? "";
    // Thank; never confirm care; private channel; calm and brief.
    expect(system).toContain("Thank the reviewer");
    expect(system).toContain("Never confirm a care relationship");
    expect(system).toContain("private channel");
    expect(system).toContain("Stay calm and brief");
    // The disclosure asymmetry the whole detector exists for.
    expect(system).toContain(
      "Their disclosure is not the practice's permission",
    );
    // Every reportable category is named.
    for (const category of SAFETY_LLM_CATEGORIES) {
      expect(system).toContain(category);
    }
  });
});
