import { URGENCY_LEVELS, type UrgencyLevel } from "@wellregarded/core";
import { describe, expect, it } from "vitest";

import { FakeAiProvider } from "../fake.js";
import {
  applyUrgencyFloor,
  hasClassifiableText,
  JUDGMENTS_PROMPT_NAME,
  type Judgments,
  JudgmentsSchema,
  judgmentsPrompt,
  judgmentsToDerivations,
  RATING_ONLY_CONFIDENCE,
  ratingOnlyDerivations,
  sentimentFromRating,
} from "./judgments.js";

const judgments = (overrides: Partial<Judgments> = {}): Judgments => ({
  sentiment: {
    value: "positive",
    confidence: 0.95,
    rationale: "Warm praise throughout.",
  },
  urgency: { value: "none", confidence: 0.9, rationale: "No action implied." },
  response_risk: {
    value: "low",
    confidence: 0.9,
    rationale: "A generic thank-you is safe.",
  },
  publication_suitability: {
    value: "suitable",
    confidence: 0.85,
    rationale: "Reads well as public proof.",
  },
  ...overrides,
});

describe("JudgmentsSchema", () => {
  it("accepts a full four-judgment result", () => {
    expect(JudgmentsSchema.parse(judgments())).toEqual(judgments());
  });

  it("rejects values outside the dimension vocabulary", () => {
    const bad = judgments();
    bad.sentiment.value = "ecstatic" as never;
    expect(JudgmentsSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects out-of-range confidence and over-long rationales", () => {
    const overConfident = judgments();
    overConfident.urgency.confidence = 1.5;
    expect(JudgmentsSchema.safeParse(overConfident).success).toBe(false);

    const rambling = judgments();
    rambling.urgency.rationale = "x".repeat(201);
    expect(JudgmentsSchema.safeParse(rambling).success).toBe(false);
  });
});

describe("judgmentsPrompt", () => {
  it("uses the stable prompt name — the FakeAiProvider fixture key", () => {
    const prompt = judgmentsPrompt({ text: "some text here", rating: "4.0" });
    expect(prompt.name).toBe(JUDGMENTS_PROMPT_NAME);
    // Never interpolate per-call data into the name.
    expect(
      judgmentsPrompt({ text: "other words entirely", rating: null }).name,
    ).toBe(prompt.name);
  });

  it("carries text and rating in the user turn", () => {
    const prompt = judgmentsPrompt({
      text: "The crown broke after a week.",
      rating: "2.0",
    });
    expect(prompt.user).toContain("The crown broke after a week.");
    expect(prompt.user).toContain("Rating: 2.0 out of 5");
    expect(prompt.system).toContain("critical");
  });

  it("renders missing text and rating explicitly", () => {
    const prompt = judgmentsPrompt({ text: null, rating: null });
    expect(prompt.user).toContain("Rating: none");
    expect(prompt.user).toContain("(none)");
  });

  it("keeps the safety-relevant urgency criteria in the system prompt", () => {
    const { system } = judgmentsPrompt({
      text: "irrelevant here too",
      rating: null,
    });
    for (const criterion of [
      "acute pain",
      "self-harm",
      "discrimination",
      "collections",
      "insurance fraud",
      "privacy",
      "vulnerable",
      "regulator",
    ]) {
      expect(system).toContain(criterion);
    }
  });
});

describe("applyUrgencyFloor", () => {
  it("bumps every level up exactly one when confidence is below 0.5", () => {
    expect(applyUrgencyFloor("none", 0.49)).toBe("low");
    expect(applyUrgencyFloor("low", 0.49)).toBe("medium");
    expect(applyUrgencyFloor("medium", 0.49)).toBe("high");
    expect(applyUrgencyFloor("high", 0.49)).toBe("critical");
  });

  it("never bumps above critical", () => {
    expect(applyUrgencyFloor("critical", 0)).toBe("critical");
  });

  it("leaves the judgment alone at exactly 0.5 and above (boundary)", () => {
    for (const level of URGENCY_LEVELS) {
      expect(applyUrgencyFloor(level, 0.5)).toBe(level);
      expect(applyUrgencyFloor(level, 0.51)).toBe(level);
      expect(applyUrgencyFloor(level, 1)).toBe(level);
    }
  });

  it("never lowers a judgment, whatever the confidence", () => {
    for (const level of URGENCY_LEVELS) {
      for (const confidence of [0, 0.25, 0.49, 0.5, 0.75, 1]) {
        const floored = applyUrgencyFloor(level, confidence);
        expect(URGENCY_LEVELS.indexOf(floored)).toBeGreaterThanOrEqual(
          URGENCY_LEVELS.indexOf(level),
        );
      }
    }
  });
});

describe("hasClassifiableText", () => {
  it("rejects null, empty, and whitespace-only text", () => {
    expect(hasClassifiableText(null)).toBe(false);
    expect(hasClassifiableText(undefined)).toBe(false);
    expect(hasClassifiableText("")).toBe(false);
    expect(hasClassifiableText("   \n\t ")).toBe(false);
  });

  it("rejects fewer than three words, accepts three or more", () => {
    expect(hasClassifiableText("Great!")).toBe(false);
    expect(hasClassifiableText("Great staff")).toBe(false);
    expect(hasClassifiableText("Great staff here")).toBe(true);
    expect(hasClassifiableText("  spaced   out   words  ")).toBe(true);
  });
});

describe("sentimentFromRating", () => {
  it("maps 1-2 negative, 3 mixed, 4-5 positive", () => {
    expect(sentimentFromRating(1)).toBe("negative");
    expect(sentimentFromRating(2)).toBe("negative");
    expect(sentimentFromRating(3)).toBe("mixed");
    expect(sentimentFromRating(4)).toBe("positive");
    expect(sentimentFromRating(5)).toBe("positive");
  });

  it("rounds halves up and clamps out-of-range values", () => {
    expect(sentimentFromRating(2.4)).toBe("negative");
    expect(sentimentFromRating(2.5)).toBe("mixed");
    expect(sentimentFromRating(3.5)).toBe("positive");
    expect(sentimentFromRating(0)).toBe("negative");
    expect(sentimentFromRating(9)).toBe("positive");
  });
});

describe("ratingOnlyDerivations", () => {
  it("derives sentiment, urgency, and publication suitability — never response_risk", () => {
    const rows = ratingOnlyDerivations(2);
    expect(rows.map((row) => row.dimension)).toEqual([
      "sentiment",
      "urgency",
      "publication_suitability",
    ]);
    for (const row of rows) {
      expect(row.basis).toBe("source_metadata");
      expect(row.modelVersion).toBeNull();
      expect(row.rationale.length).toBeGreaterThan(0);
    }
  });

  it("maps the rating deterministically with confidence 0.6", () => {
    const rows = ratingOnlyDerivations(2);
    const byDimension = Object.fromEntries(
      rows.map((row) => [row.dimension, row]),
    );
    expect(byDimension.sentiment?.value).toBe("negative");
    expect(byDimension.sentiment?.confidence).toBe(RATING_ONLY_CONFIDENCE);
    expect(byDimension.urgency?.value).toBe("none");
    expect(byDimension.publication_suitability?.value).toBe("unsuitable");
    expect(byDimension.publication_suitability?.confidence).toBe(1);
  });

  it("gives a 1-star rating urgency low instead of none", () => {
    const urgency = ratingOnlyDerivations(1).find(
      (row) => row.dimension === "urgency",
    );
    expect(urgency?.value).toBe("low");
  });
});

describe("judgmentsToDerivations", () => {
  it("produces four rows with basis inferred_text and the concrete model id", () => {
    const rows = judgmentsToDerivations(
      judgments(),
      "claude-haiku-4-5-20251001",
    );
    expect(rows.map((row) => row.dimension)).toEqual([
      "sentiment",
      "urgency",
      "response_risk",
      "publication_suitability",
    ]);
    for (const row of rows) {
      expect(row.basis).toBe("inferred_text");
      expect(row.modelVersion).toBe("claude-haiku-4-5-20251001");
    }
    expect(rows[0]).toMatchObject({
      value: "positive",
      confidence: 0.95,
      rationale: "Warm praise throughout.",
    });
  });

  it("floors low-confidence urgency up a level, keeping the model's confidence", () => {
    const ambiguous = judgments({
      urgency: {
        value: "medium" satisfies UrgencyLevel,
        confidence: 0.4,
        rationale: "Might be an unresolved complaint.",
      },
    });
    const urgency = judgmentsToDerivations(ambiguous, "m").find(
      (row) => row.dimension === "urgency",
    );
    expect(urgency).toMatchObject({
      value: "high",
      confidence: 0.4,
      rationale: "Might be an unresolved complaint.",
    });
  });

  it("does not floor urgency at or above 0.5", () => {
    const urgency = judgmentsToDerivations(judgments(), "m").find(
      (row) => row.dimension === "urgency",
    );
    expect(urgency?.value).toBe("none");
  });
});

describe("FakeAiProvider round-trip", () => {
  it("serves a judgments fixture through the real prompt and schema", async () => {
    const provider = new FakeAiProvider({
      [JUDGMENTS_PROMPT_NAME]: [judgments()],
    });
    const result = await provider.classify(
      judgmentsPrompt({
        text: "Wonderful hygienist, gentle cleaning.",
        rating: "5.0",
      }),
      JudgmentsSchema,
      { purpose: "judgments", practiceId: null, model: "pipeline" },
    );
    expect(result.value).toEqual(judgments());
    expect(result.usage.model).toBe("fake-pipeline");
  });
});
