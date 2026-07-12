// The deterministic urgent-keyword fallback (issue #75 requirement 4):
// hits, word boundaries, the stem match, and non-hits like "painless".
import { describe, expect, it } from "vitest";

import {
  keywordUrgencyDerivation,
  matchUrgentKeywords,
  URGENT_KEYWORD_CONFIDENCE,
  URGENT_KEYWORD_MODEL_VERSION,
} from "./urgent-keywords.js";

describe("matchUrgentKeywords", () => {
  it("matches single keywords case-insensitively", () => {
    expect(matchUrgentKeywords("This is an EMERGENCY")).toContain("emergency");
    expect(
      matchUrgentKeywords("still bleeding after the extraction"),
    ).toContain("bleeding");
  });

  it("matches multi-word phrases, tolerating extra whitespace", () => {
    expect(matchUrgentKeywords("severe  pain since Tuesday")).toContain(
      "severe pain",
    );
    expect(matchUrgentKeywords("ended up in the Emergency Room")).toContain(
      "emergency room",
    );
  });

  it("matches apostrophe phrases", () => {
    expect(matchUrgentKeywords("I can't eat on that side")).toContain(
      "can't eat",
    );
  });

  it("matches the discriminat- stem across suffixes", () => {
    for (const text of [
      "they discriminated against me",
      "this is discrimination",
      "a discriminatory policy",
    ]) {
      expect(matchUrgentKeywords(text)).toContain("discriminat-");
    }
  });

  it("is word-boundary aware: no substring false positives", () => {
    expect(matchUrgentKeywords("the cleaning was painless")).toEqual([]);
    // "sue" must not fire inside "tissue"; "board" not inside "aboard".
    expect(matchUrgentKeywords("some gum tissue soreness")).toEqual([]);
    expect(matchUrgentKeywords("we climbed aboard the tram")).toEqual([]);
    // "ER" must not fire inside ordinary words.
    expect(matchUrgentKeywords("a very tender molar")).toEqual([]);
  });

  it("returns every distinct hit once, in list order", () => {
    const matches = matchUrgentKeywords(
      "Urgent: infection and swelling, calling my lawyer. Urgent!",
    );
    expect(matches).toEqual(["urgent", "swelling", "infection", "lawyer"]);
  });

  it("returns [] for calm text", () => {
    expect(
      matchUrgentKeywords("Lovely visit, the hygienist was gentle and kind."),
    ).toEqual([]);
  });
});

describe("keywordUrgencyDerivation", () => {
  it("writes the exact issue-#75 contract", () => {
    const row = keywordUrgencyDerivation(["emergency", "bleeding"]);
    expect(row).toMatchObject({
      dimension: "urgency",
      value: "high",
      confidence: URGENT_KEYWORD_CONFIDENCE,
      basis: "inferred_text",
      modelVersion: URGENT_KEYWORD_MODEL_VERSION,
    });
    expect(row.modelVersion).toBe("keyword-fallback-v1");
    expect(row.rationale).toContain("emergency, bleeding");
  });
});
