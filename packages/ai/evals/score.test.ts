/**
 * Unit tests for the pure scoring functions (issue #73). Everything here
 * runs with synthetic outputs — no API key, no provider, no filesystem.
 */

import { describe, expect, it } from "vitest";

import type { Judgments } from "../src/prompts/judgments.js";
import {
  type CharSpan,
  type ExcerptsCaseResult,
  evaluateExcerptsThresholds,
  evaluateJudgmentsThresholds,
  evaluateSafetyThresholds,
  type JudgmentsCaseResult,
  type SafetyCaseResult,
  scoreExcerpts,
  scoreJudgments,
  scoreSafety,
  spanF1,
  tokenSpans,
} from "./score.js";

// ---------------------------------------------------------------------------
// Judgments
// ---------------------------------------------------------------------------

const judgments = (
  values: {
    sentiment?: string;
    urgency?: string;
    response_risk?: string;
    publication_suitability?: string;
  },
  confidence = 0.9,
): Judgments =>
  ({
    sentiment: {
      value: values.sentiment ?? "positive",
      confidence,
      rationale: "r",
    },
    urgency: { value: values.urgency ?? "none", confidence, rationale: "r" },
    response_risk: {
      value: values.response_risk ?? "low",
      confidence,
      rationale: "r",
    },
    publication_suitability: {
      value: values.publication_suitability ?? "suitable",
      confidence,
      rationale: "r",
    },
  }) as Judgments;

const expectedAllPositive = {
  sentiment: "positive",
  urgency: "none",
  response_risk: "low",
  publication_suitability: "suitable",
};

describe("scoreJudgments", () => {
  it("scores a perfect run at accuracy 1 on every dimension", () => {
    const results: JudgmentsCaseResult[] = [
      { id: "a", expected: expectedAllPositive, actual: judgments({}) },
      { id: "b", expected: expectedAllPositive, actual: judgments({}) },
    ];
    const score = scoreJudgments(results);
    for (const dimension of [
      "sentiment",
      "urgency",
      "response_risk",
      "publication_suitability",
    ] as const) {
      expect(score.perDimension[dimension]).toEqual({
        correct: 2,
        total: 2,
        accuracy: 1,
      });
    }
    expect(score.missedUrgent).toEqual([]);
    expect(score.failures).toEqual([]);
  });

  it("computes per-dimension accuracy independently", () => {
    const results: JudgmentsCaseResult[] = [
      { id: "a", expected: expectedAllPositive, actual: judgments({}) },
      {
        id: "b",
        expected: expectedAllPositive,
        // sentiment wrong, everything else right
        actual: judgments({ sentiment: "mixed" }),
      },
    ];
    const score = scoreJudgments(results);
    expect(score.perDimension.sentiment.accuracy).toBe(0.5);
    expect(score.perDimension.urgency.accuracy).toBe(1);
    expect(score.failures).toHaveLength(1);
    expect(score.failures[0]?.id).toBe("b");
    expect(score.failures[0]?.problems[0]).toContain("sentiment");
  });

  it("counts a failed call as a miss on every dimension", () => {
    const results: JudgmentsCaseResult[] = [
      {
        id: "a",
        expected: expectedAllPositive,
        actual: null,
        error: "validation failed",
      },
    ];
    const score = scoreJudgments(results);
    expect(score.perDimension.sentiment.accuracy).toBe(0);
    expect(score.perDimension.publication_suitability.accuracy).toBe(0);
    expect(score.failures[0]?.error).toBe("validation failed");
  });

  describe("missed-urgent (zero tolerance)", () => {
    const urgentExpected = { ...expectedAllPositive, urgency: "high" };

    it("flags expected high scored medium or below", () => {
      const score = scoreJudgments([
        {
          id: "miss",
          expected: urgentExpected,
          actual: judgments({ urgency: "medium" }),
        },
      ]);
      expect(score.missedUrgent).toEqual(["miss"]);
    });

    it("flags expected critical scored below high, and failed calls", () => {
      const score = scoreJudgments([
        {
          id: "crit-low",
          expected: { ...expectedAllPositive, urgency: "critical" },
          actual: judgments({ urgency: "low" }),
        },
        {
          id: "crit-err",
          expected: { ...expectedAllPositive, urgency: "critical" },
          actual: null,
          error: "boom",
        },
      ]);
      expect(score.missedUrgent).toEqual(["crit-low", "crit-err"]);
    });

    it("does NOT flag expected high scored critical (over-alarm is not a miss)", () => {
      const score = scoreJudgments([
        {
          id: "over",
          expected: urgentExpected,
          actual: judgments({ urgency: "critical" }),
        },
      ]);
      expect(score.missedUrgent).toEqual([]);
      // ...but exact-match accuracy still records the mismatch.
      expect(score.perDimension.urgency.accuracy).toBe(0);
    });

    it("does NOT flag expected medium scored none — the rule only guards high/critical", () => {
      const score = scoreJudgments([
        {
          id: "med",
          expected: { ...expectedAllPositive, urgency: "medium" },
          actual: judgments({ urgency: "none" }),
        },
      ]);
      expect(score.missedUrgent).toEqual([]);
    });
  });

  describe("confidence bands", () => {
    it("applies an array band to every dimension, inclusive at both ends", () => {
      const expected = {
        ...expectedAllPositive,
        confidence_band: [0.6, 0.9] as [number, number],
      };
      const atLow = scoreJudgments([
        { id: "low", expected, actual: judgments({}, 0.6) },
      ]);
      expect(atLow.confidenceBand.checked).toBe(4);
      expect(atLow.confidenceBand.violations).toEqual([]);

      const atHigh = scoreJudgments([
        { id: "high", expected, actual: judgments({}, 0.9) },
      ]);
      expect(atHigh.confidenceBand.violations).toEqual([]);

      const below = scoreJudgments([
        { id: "below", expected, actual: judgments({}, 0.59) },
      ]);
      expect(below.confidenceBand.violations).toHaveLength(4);

      const above = scoreJudgments([
        { id: "above", expected, actual: judgments({}, 0.91) },
      ]);
      expect(above.confidenceBand.violations).toHaveLength(4);
    });

    it("checks only the listed dimensions for a per-dimension band object", () => {
      const expected = {
        ...expectedAllPositive,
        confidence_band: { sentiment: [0.5, 1.0] as [number, number] },
      };
      const score = scoreJudgments([
        { id: "a", expected, actual: judgments({}, 0.2) },
      ]);
      expect(score.confidenceBand.checked).toBe(1);
      expect(score.confidenceBand.violations).toEqual([
        { id: "a", dimension: "sentiment", confidence: 0.2, band: [0.5, 1.0] },
      ]);
    });

    it("skips band checks entirely when the call failed", () => {
      const expected = {
        ...expectedAllPositive,
        confidence_band: [0.5, 1.0] as [number, number],
      };
      const score = scoreJudgments([
        { id: "a", expected, actual: null, error: "boom" },
      ]);
      expect(score.confidenceBand.checked).toBe(0);
    });
  });
});

describe("judgments thresholds", () => {
  const passingScore = () =>
    scoreJudgments([
      { id: "a", expected: expectedAllPositive, actual: judgments({}) },
    ]);

  it("passes exactly at the accuracy threshold", () => {
    // 17/20 = 0.85 exactly.
    const results: JudgmentsCaseResult[] = [];
    for (let i = 0; i < 17; i++) {
      results.push({
        id: `ok-${i}`,
        expected: expectedAllPositive,
        actual: judgments({}),
      });
    }
    for (let i = 0; i < 3; i++) {
      results.push({
        id: `bad-${i}`,
        expected: expectedAllPositive,
        actual: judgments({ sentiment: "negative" }),
      });
    }
    const score = scoreJudgments(results);
    expect(score.perDimension.sentiment.accuracy).toBeCloseTo(0.85);
    const verdict = evaluateJudgmentsThresholds(score, {
      judgments: { enum_accuracy_per_dimension: 0.85 },
    });
    expect(verdict.passed).toBe(true);
  });

  it("fails just below the accuracy threshold, naming the dimension", () => {
    const results: JudgmentsCaseResult[] = [];
    for (let i = 0; i < 16; i++) {
      results.push({
        id: `ok-${i}`,
        expected: expectedAllPositive,
        actual: judgments({}),
      });
    }
    for (let i = 0; i < 4; i++) {
      results.push({
        id: `bad-${i}`,
        expected: expectedAllPositive,
        actual: judgments({ urgency: "low" }),
      });
    }
    const verdict = evaluateJudgmentsThresholds(scoreJudgments(results), {
      judgments: { enum_accuracy_per_dimension: 0.85 },
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toContain("urgency");
  });

  it("fails on a single missed-urgent regardless of accuracy", () => {
    const results: JudgmentsCaseResult[] = [];
    for (let i = 0; i < 99; i++) {
      results.push({
        id: `ok-${i}`,
        expected: expectedAllPositive,
        actual: judgments({}),
      });
    }
    results.push({
      id: "the-miss",
      expected: { ...expectedAllPositive, urgency: "critical" },
      actual: judgments({ urgency: "medium" }),
    });
    const verdict = evaluateJudgmentsThresholds(scoreJudgments(results), {
      judgments: { enum_accuracy_per_dimension: 0.85, missed_urgent_max: 0 },
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.some((f) => f.includes("the-miss"))).toBe(true);
  });

  it("passes when the thresholds object is empty (ungated)", () => {
    const verdict = evaluateJudgmentsThresholds(passingScore(), {});
    expect(verdict.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Excerpts — span F1
// ---------------------------------------------------------------------------

describe("tokenSpans", () => {
  it("returns character spans of whitespace-delimited tokens", () => {
    expect(tokenSpans("ab  cd")).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ]);
    expect(tokenSpans("")).toEqual([]);
  });
});

describe("spanF1", () => {
  const text = "one two three four five six seven eight";
  // Tokens: one[0,3] two[4,7] three[8,13] four[14,18] five[19,23] six[24,27]
  //         seven[28,33] eight[34,39]
  const span = (start: number, end: number): CharSpan => ({ start, end });

  it("scores identical spans at 1/1/1", () => {
    const spans = [span(0, 13)];
    expect(spanF1(text, spans, spans)).toEqual({
      precision: 1,
      recall: 1,
      f1: 1,
    });
  });

  it("scores disjoint spans at 0/0/0", () => {
    expect(spanF1(text, [span(0, 13)], [span(28, 39)])).toEqual({
      precision: 0,
      recall: 0,
      f1: 0,
    });
  });

  it("scores a crafted partial overlap: 2 shared of 4 each = 0.5/0.5/0.5", () => {
    // expected covers one..four (4 tokens); produced covers three..six
    // (4 tokens); shared = three, four.
    const result = spanF1(text, [span(0, 18)], [span(8, 27)]);
    expect(result.precision).toBeCloseTo(0.5);
    expect(result.recall).toBeCloseTo(0.5);
    expect(result.f1).toBeCloseTo(0.5);
  });

  it("forgives a span that starts one word earlier than the label", () => {
    // expected: two..four (3 tokens); produced: one..four (4 tokens).
    const result = spanF1(text, [span(4, 18)], [span(0, 18)]);
    expect(result.recall).toBe(1);
    expect(result.precision).toBeCloseTo(3 / 4);
    expect(result.f1).toBeGreaterThan(0.85);
  });

  it("counts a token as covered on ANY character overlap", () => {
    // Span clips only the first character of "two".
    const result = spanF1(text, [span(4, 7)], [span(0, 5)]);
    expect(result.recall).toBe(1);
  });

  it("handles multiple spans per side", () => {
    const result = spanF1(
      text,
      [span(0, 7), span(28, 39)], // one,two + seven,eight
      [span(0, 7), span(28, 33)], // one,two + seven
    );
    expect(result.precision).toBe(1);
    expect(result.recall).toBeCloseTo(3 / 4);
  });

  it("scores empty-vs-empty as 1 and one-sided-empty as 0", () => {
    expect(spanF1(text, [], []).f1).toBe(1);
    expect(spanF1(text, [span(0, 3)], []).f1).toBe(0);
    expect(spanF1(text, [], [span(0, 3)]).f1).toBe(0);
  });
});

describe("scoreExcerpts", () => {
  const text = "one two three four";
  const full: CharSpan = { start: 0, end: 18 };

  const okCase = (id: string): ExcerptsCaseResult => ({
    id,
    text,
    expected: [full],
    produced: [full],
    verbatimViolations: [],
  });

  it("macro-averages F1 across cases, scoring failed calls 0", () => {
    const score = scoreExcerpts([
      okCase("perfect"),
      {
        id: "failed",
        text,
        expected: [full],
        produced: null,
        verbatimViolations: [],
        error: "boom",
      },
    ]);
    expect(score.meanF1).toBeCloseTo(0.5);
    expect(score.failures.map((f) => f.id)).toEqual(["failed"]);
  });

  it("records verbatim violations even when the located spans score well", () => {
    const score = scoreExcerpts([
      {
        id: "fabricated",
        text,
        expected: [full],
        produced: [full],
        verbatimViolations: ["a paraphrased quote"],
      },
    ]);
    expect(score.meanF1).toBe(1);
    expect(score.verbatimViolations).toEqual([
      { id: "fabricated", texts: ["a paraphrased quote"] },
    ]);
    expect(score.failures[0]?.problems[0]).toContain("VERBATIM VIOLATION");
  });
});

describe("excerpts thresholds", () => {
  const text = "one two three four";
  const full: CharSpan = { start: 0, end: 18 };

  it("passes exactly at the F1 threshold and fails below it", () => {
    const mk = (produced: CharSpan[]): ExcerptsCaseResult => ({
      id: "a",
      text,
      expected: [full],
      produced,
      verbatimViolations: [],
    });
    const perfect = scoreExcerpts([mk([full])]);
    expect(
      evaluateExcerptsThresholds(perfect, { excerpts: { span_f1_mean: 1.0 } })
        .passed,
    ).toBe(true);

    const partial = scoreExcerpts([mk([{ start: 0, end: 7 }])]);
    expect(partial.meanF1).toBeLessThan(1);
    expect(
      evaluateExcerptsThresholds(partial, { excerpts: { span_f1_mean: 1.0 } })
        .passed,
    ).toBe(false);
  });

  it("fails on a single verbatim violation with zero tolerance", () => {
    const score = scoreExcerpts([
      {
        id: "fab",
        text,
        expected: [full],
        produced: [full],
        verbatimViolations: ["made up"],
      },
    ]);
    const verdict = evaluateExcerptsThresholds(score, {
      excerpts: { span_f1_mean: 0.5, verbatim_violations_max: 0 },
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.failures[0]).toContain("verbatim");
  });
});

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

describe("scoreSafety", () => {
  const c = (
    id: string,
    expected: "ok" | "warn" | "block",
    actual: "ok" | "warn" | "block" | null,
    mustBlock = false,
  ): SafetyCaseResult => ({
    id,
    expected: mustBlock
      ? { level: expected, must_block: true }
      : { level: expected },
    actual,
    ...(actual === null ? { error: "boom" } : {}),
  });

  it("computes level accuracy and block precision/recall", () => {
    const score = scoreSafety([
      c("tp", "block", "block", true),
      c("fn", "block", "warn"),
      c("fp", "ok", "block"),
      c("tn", "ok", "ok"),
    ]);
    expect(score.levelAccuracy).toBe(0.5);
    expect(score.block).toEqual({
      expectedBlocks: 2,
      producedBlocks: 2,
      correctBlocks: 1,
      precision: 0.5,
      recall: 0.5,
    });
  });

  it("returns precision/recall 1 when nothing block-related happened", () => {
    const score = scoreSafety([c("a", "ok", "ok"), c("b", "warn", "warn")]);
    expect(score.block.precision).toBe(1);
    expect(score.block.recall).toBe(1);
  });

  it("flags every must_block case scored below block, including failures", () => {
    const score = scoreSafety([
      c("caught", "block", "block", true),
      c("missed-warn", "block", "warn", true),
      c("missed-err", "block", null, true),
    ]);
    expect(score.missedMustBlock).toEqual(["missed-warn", "missed-err"]);
  });

  it("does not flag a non-must_block expected block scored below", () => {
    const score = scoreSafety([c("soft-miss", "block", "warn")]);
    expect(score.missedMustBlock).toEqual([]);
    expect(score.block.recall).toBe(0);
  });
});

describe("safety thresholds", () => {
  const c = (
    id: string,
    expected: "ok" | "warn" | "block",
    actual: "ok" | "warn" | "block",
    mustBlock = false,
  ): SafetyCaseResult => ({
    id,
    expected: mustBlock
      ? { level: expected, must_block: true }
      : { level: expected },
    actual,
  });

  it("the zero-tolerance rule fails the run even when aggregates pass", () => {
    // 9 correct blocks + 1 missed must_block: recall 0.9, precision 1.
    const results: SafetyCaseResult[] = [];
    for (let i = 0; i < 9; i++) results.push(c(`b-${i}`, "block", "block"));
    results.push(c("the-miss", "block", "warn", true));
    const score = scoreSafety(results);
    const verdict = evaluateSafetyThresholds(score, {
      safety: { block_precision_min: 0.8, missed_must_block_max: 0 },
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.some((f) => f.includes("the-miss"))).toBe(true);
    expect(verdict.failures.some((f) => f.includes("zero tolerance"))).toBe(
      true,
    );
  });

  it("block recall 1.0 requires catching every expected block", () => {
    const perfect = scoreSafety([c("a", "block", "block"), c("b", "ok", "ok")]);
    expect(
      evaluateSafetyThresholds(perfect, { safety: { block_recall_min: 1.0 } })
        .passed,
    ).toBe(true);

    const miss = scoreSafety([c("a", "block", "ok"), c("b", "block", "block")]);
    expect(
      evaluateSafetyThresholds(miss, { safety: { block_recall_min: 1.0 } })
        .passed,
    ).toBe(false);
  });

  it("precision passes exactly at the threshold and fails below", () => {
    // 4 correct of 5 produced blocks = 0.8 exactly.
    const results = [
      c("1", "block", "block"),
      c("2", "block", "block"),
      c("3", "block", "block"),
      c("4", "block", "block"),
      c("5", "ok", "block"),
    ];
    const verdict = evaluateSafetyThresholds(scoreSafety(results), {
      safety: { block_precision_min: 0.8 },
    });
    expect(verdict.passed).toBe(true);

    const worse = evaluateSafetyThresholds(
      scoreSafety([...results, c("6", "warn", "block")]),
      { safety: { block_precision_min: 0.8 } },
    );
    expect(worse.passed).toBe(false);
  });
});
