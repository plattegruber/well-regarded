/**
 * Runner plumbing tests (issue #73) — FakeAiProvider only, never the live
 * API. The live run is `pnpm eval`'s job; these tests pin down case
 * selection, the excerpt retry path, degraded-mode detection, usage
 * accounting, report rendering, and the end-to-end runEvalSet wiring.
 */

import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { AiRequestError, AiValidationError } from "../src/errors.js";
import { FakeAiProvider } from "../src/fake.js";
import { EXCERPTS_PROMPT_NAME } from "../src/prompts/excerpts.js";
import { JUDGMENTS_PROMPT_NAME } from "../src/prompts/judgments.js";
import { SAFETY_PROMPT_NAME } from "../src/prompts/safety.js";
import type {
  AiProvider,
  AiResult,
  ClassifyOpts,
  ClassifyPrompt,
} from "../src/provider.js";
import type {
  ExcerptsFixture,
  JudgmentsFixture,
  SafetyFixture,
} from "./cases.js";
import {
  runEvalSet,
  runExcerptsEval,
  runJudgmentsEval,
  runSafetyEval,
  selectCases,
  UsageRecordingProvider,
} from "./runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const judgment = (value: string, confidence = 0.9) => ({
  value,
  confidence,
  rationale: "because",
});

const judgmentsResponse = (overrides: Record<string, unknown> = {}) => ({
  sentiment: judgment("positive"),
  urgency: judgment("none"),
  response_risk: judgment("low"),
  publication_suitability: judgment("suitable"),
  ...overrides,
});

const judgmentsFixture = (
  id: string,
  expected: Partial<JudgmentsFixture["expected"]> = {},
): JudgmentsFixture => ({
  id,
  prompt: JUDGMENTS_PROMPT_NAME,
  input: { text: `review text for ${id}`, rating: "4.0" },
  expected: {
    sentiment: "positive",
    urgency: "none",
    response_risk: "low",
    publication_suitability: "suitable",
    ...expected,
  },
  notes: "test fixture",
});

const excerptsFixture = (
  id: string,
  text: string,
  spans: string[],
): ExcerptsFixture => ({
  id,
  prompt: EXCERPTS_PROMPT_NAME,
  input: { text, rating: "4.0" },
  expected: {
    excerpts: spans.map((span) => ({
      text: span,
      start_offset: text.indexOf(span),
      topic_hint: "hint",
    })),
  },
  notes: "test fixture",
});

const safetyFixture = (
  id: string,
  draft: string,
  level: "ok" | "warn" | "block",
  mustBlock = false,
): SafetyFixture => ({
  id,
  prompt: SAFETY_PROMPT_NAME,
  input: {
    draft,
    review: { text: "the review", rating: "2.0", visibility: "public" },
  },
  expected: mustBlock ? { level, must_block: true } : { level },
  notes: "test fixture",
});

/** A provider that always throws the given AI error. */
class ThrowingProvider implements AiProvider {
  readonly #error: Error;
  constructor(error: Error) {
    this.#error = error;
  }
  classify<T>(
    _prompt: ClassifyPrompt,
    _schema: z.ZodType<T>,
    _opts: ClassifyOpts,
  ): Promise<AiResult<T>> {
    return Promise.reject(this.#error);
  }
}

// ---------------------------------------------------------------------------
// selectCases
// ---------------------------------------------------------------------------

describe("selectCases", () => {
  const fixtures = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("returns everything by default and applies --limit", () => {
    expect(selectCases(fixtures, {})).toHaveLength(3);
    expect(selectCases(fixtures, { limit: 2 }).map((f) => f.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("filters by --only and throws on unknown ids", () => {
    expect(
      selectCases(fixtures, { only: ["c", "a"] }).map((f) => f.id),
    ).toEqual(["a", "c"]);
    expect(() => selectCases(fixtures, { only: ["nope"] })).toThrow(
      /not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// runJudgmentsEval
// ---------------------------------------------------------------------------

describe("runJudgmentsEval", () => {
  it("runs every case in order and pairs raw model output with expectations", async () => {
    const provider = new FakeAiProvider({
      [JUDGMENTS_PROMPT_NAME]: [
        judgmentsResponse(),
        judgmentsResponse({ urgency: judgment("medium") }),
      ],
    });
    const results = await runJudgmentsEval(provider, [
      judgmentsFixture("first"),
      judgmentsFixture("second", { urgency: "high" }),
    ]);
    expect(results.map((r) => r.id)).toEqual(["first", "second"]);
    expect(results[0]?.actual?.sentiment.value).toBe("positive");
    expect(results[1]?.actual?.urgency.value).toBe("medium");
    expect(results[1]?.expected.urgency).toBe("high");
  });

  it("records AI errors as failed cases instead of aborting the run", async () => {
    const provider = new ThrowingProvider(
      new AiValidationError({
        promptName: JUDGMENTS_PROMPT_NAME,
        purpose: "eval:judgments",
        issues: "sentiment: invalid",
      }),
    );
    const results = await runJudgmentsEval(provider, [judgmentsFixture("a")]);
    expect(results[0]?.actual).toBeNull();
    expect(results[0]?.error).toContain("failed schema validation");
  });

  it("rethrows non-AI errors (a runner bug must not score as a model miss)", async () => {
    const provider = new ThrowingProvider(new TypeError("bug"));
    await expect(
      runJudgmentsEval(provider, [judgmentsFixture("a")]),
    ).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// runExcerptsEval
// ---------------------------------------------------------------------------

describe("runExcerptsEval", () => {
  const text = "The dentist was great. The billing was a mess.";

  it("locates produced excerpts as character spans", async () => {
    const provider = new FakeAiProvider({
      [EXCERPTS_PROMPT_NAME]: [
        {
          excerpts: [
            { text: "The dentist was great.", topic_hint: "care" },
            { text: "The billing was a mess.", topic_hint: "billing" },
          ],
        },
      ],
    });
    const results = await runExcerptsEval(provider, [
      excerptsFixture("a", text, ["The dentist was great."]),
    ]);
    expect(results[0]?.produced).toEqual([
      { start: 0, end: 22 },
      { start: 23, end: 46 },
    ]);
    expect(results[0]?.verbatimViolations).toEqual([]);
  });

  it("retries once on fabricated excerpts and keeps still-invalid ones as violations", async () => {
    const provider = new FakeAiProvider({
      [EXCERPTS_PROMPT_NAME]: [
        // First response: one valid, one paraphrased.
        {
          excerpts: [
            { text: "The dentist was great.", topic_hint: "care" },
            { text: "Billing was chaotic.", topic_hint: "billing" },
          ],
        },
        // Retry response: still fabricates.
        {
          excerpts: [
            { text: "The dentist was great.", topic_hint: "care" },
            { text: "Billing was chaotic.", topic_hint: "billing" },
          ],
        },
      ],
    });
    const results = await runExcerptsEval(provider, [
      excerptsFixture("a", text, ["The dentist was great."]),
    ]);
    expect(provider.calls).toHaveLength(2);
    // The retry prompt carries the violations back to the model.
    expect(provider.calls[1]?.prompt.user).toContain("Billing was chaotic.");
    expect(results[0]?.verbatimViolations).toEqual(["Billing was chaotic."]);
    expect(results[0]?.produced).toEqual([{ start: 0, end: 22 }]);
  });

  it("does not retry when every excerpt is verbatim", async () => {
    const provider = new FakeAiProvider({
      [EXCERPTS_PROMPT_NAME]: [
        { excerpts: [{ text: "The dentist was great.", topic_hint: "care" }] },
      ],
    });
    await runExcerptsEval(provider, [
      excerptsFixture("a", text, ["The dentist was great."]),
    ]);
    expect(provider.calls).toHaveLength(1);
  });

  it("records AI errors as failed cases", async () => {
    const provider = new ThrowingProvider(
      new AiRequestError("rate limited", { status: 429, attempts: 3 }),
    );
    const results = await runExcerptsEval(provider, [
      excerptsFixture("a", text, ["The dentist was great."]),
    ]);
    expect(results[0]?.produced).toBeNull();
    expect(results[0]?.error).toContain("rate limited");
  });
});

// ---------------------------------------------------------------------------
// runSafetyEval
// ---------------------------------------------------------------------------

describe("runSafetyEval", () => {
  it("runs the FULL two-layer detector (deterministic + model)", async () => {
    // Deterministic layer blocks "your bill" with no model finding needed.
    const provider = new FakeAiProvider({
      [SAFETY_PROMPT_NAME]: [{ findings: [] }, { findings: [] }],
    });
    const results = await runSafetyEval(provider, [
      safetyFixture("det-block", "Your bill was high.", "block", true),
      safetyFixture("clean", "Thank you for the feedback!", "ok"),
    ]);
    expect(results[0]?.actual).toBe("block");
    expect(results[0]?.error).toBeUndefined();
    expect(results[1]?.actual).toBe("ok");
  });

  it("applies model findings through the server-side severity policy", async () => {
    const provider = new FakeAiProvider({
      [SAFETY_PROMPT_NAME]: [
        {
          findings: [
            {
              category: "confirms_care_relationship",
              quote: "having you as a patient",
              reason: "confirms care",
              suggestion: null,
            },
          ],
        },
      ],
    });
    const results = await runSafetyEval(provider, [
      safetyFixture(
        "llm-block",
        "We loved having you as a patient!",
        "block",
        true,
      ),
    ]);
    expect(results[0]?.actual).toBe("block");
  });

  it("marks degraded mode (model call failed) as a case error", async () => {
    const provider = new ThrowingProvider(
      new AiRequestError("api down", { attempts: 3 }),
    );
    const results = await runSafetyEval(provider, [
      safetyFixture("degraded", "Thank you for the feedback!", "ok"),
    ]);
    // Deterministic layer alone says ok, but the eval must not pretend the
    // model was measured.
    expect(results[0]?.actual).toBe("ok");
    expect(results[0]?.error).toContain("llm:skipped");
  });
});

// ---------------------------------------------------------------------------
// UsageRecordingProvider
// ---------------------------------------------------------------------------

describe("UsageRecordingProvider", () => {
  it("accumulates calls, tokens, and distinct model ids", async () => {
    const provider = new UsageRecordingProvider(
      new FakeAiProvider({
        [JUDGMENTS_PROMPT_NAME]: [judgmentsResponse(), judgmentsResponse()],
      }),
    );
    await runJudgmentsEval(provider, [
      judgmentsFixture("a"),
      judgmentsFixture("b"),
    ]);
    expect(provider.totals.calls).toBe(2);
    expect(provider.totals.models).toEqual(["fake-pipeline"]);
    // FakeAiProvider reports zero tokens — the wrapper just sums.
    expect(provider.totals.inputTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runEvalSet — end to end with a fake provider
// ---------------------------------------------------------------------------

describe("runEvalSet", () => {
  const thresholds = {
    judgments: { enum_accuracy_per_dimension: 0.85, missed_urgent_max: 0 },
    excerpts: { span_f1_mean: 0.75, verbatim_violations_max: 0 },
    safety: {
      block_recall_min: 1.0,
      block_precision_min: 0.8,
      missed_must_block_max: 0,
    },
  };

  const fixtures = {
    judgments: [
      judgmentsFixture("j-1"),
      judgmentsFixture("j-2", { urgency: "critical" }),
    ],
    excerpts: [
      excerptsFixture("e-1", "The dentist was great. The billing was a mess.", [
        "The dentist was great.",
        "The billing was a mess.",
      ]),
    ],
    safety: [safetyFixture("s-1", "Your bill was high.", "block", true)],
  };

  it("produces a PASS report and filename stamped with date and model", async () => {
    const provider = new FakeAiProvider({
      [JUDGMENTS_PROMPT_NAME]: [
        judgmentsResponse(),
        judgmentsResponse({ urgency: judgment("critical") }),
      ],
    });
    const outcome = await runEvalSet({
      set: "judgments",
      provider,
      options: {},
      thresholds,
      date: "2026-07-11",
      fixtures,
    });
    expect(outcome.verdict.passed).toBe(true);
    expect(outcome.reportFilename).toBe(
      "judgments-2026-07-11-fake-pipeline.md",
    );
    expect(outcome.report).toContain("**Verdict:** PASS");
    expect(outcome.report).toContain("| sentiment | 100.0% | 2/2 |");
    expect(outcome.report).toContain("Missed-urgent (headline):** 0");
  });

  it("fails the verdict and lists model-vs-expected on a missed urgent", async () => {
    const provider = new FakeAiProvider({
      [JUDGMENTS_PROMPT_NAME]: [
        judgmentsResponse(),
        judgmentsResponse({ urgency: judgment("low") }), // expected critical
      ],
    });
    const outcome = await runEvalSet({
      set: "judgments",
      provider,
      options: {},
      thresholds,
      date: "2026-07-11",
      fixtures,
    });
    expect(outcome.verdict.passed).toBe(false);
    expect(outcome.verdict.failures.some((f) => f.includes("j-2"))).toBe(true);
    expect(outcome.report).toContain("**Verdict:** FAIL");
    expect(outcome.report).toContain("### j-2");
    expect(outcome.report).toContain("MISSED URGENT");
    // Model output and expectation are both in the failure detail.
    expect(outcome.report).toContain('"expected"');
    expect(outcome.report).toContain('"actual"');
  });

  it("marks partial runs (--only / --limit) in the report", async () => {
    const provider = new FakeAiProvider({
      [JUDGMENTS_PROMPT_NAME]: [judgmentsResponse()],
    });
    const outcome = await runEvalSet({
      set: "judgments",
      provider,
      options: { only: ["j-1"] },
      thresholds,
      date: "2026-07-11",
      fixtures,
    });
    expect(outcome.verdict.passed).toBe(true);
    expect(outcome.report).toContain("partial run");
  });

  it("fails the safety set on a missed must_block", async () => {
    const provider = new FakeAiProvider({
      [SAFETY_PROMPT_NAME]: [{ findings: [] }],
    });
    const outcome = await runEvalSet({
      set: "safety",
      provider,
      options: {},
      thresholds,
      date: "2026-07-11",
      fixtures: {
        ...fixtures,
        safety: [
          // No deterministic rule fires and the fake model reports nothing,
          // so this must_block case scores ok -> zero-tolerance failure.
          safetyFixture(
            "llm-miss",
            "We loved having you as a patient!",
            "block",
            true,
          ),
        ],
      },
    });
    expect(outcome.verdict.passed).toBe(false);
    expect(
      outcome.verdict.failures.some((f) => f.includes("zero tolerance")),
    ).toBe(true);
  });

  it("passes the excerpts set on verbatim output and reports F1 per case", async () => {
    const provider = new FakeAiProvider({
      [EXCERPTS_PROMPT_NAME]: [
        {
          excerpts: [
            { text: "The dentist was great.", topic_hint: "care" },
            { text: "The billing was a mess.", topic_hint: "billing" },
          ],
        },
      ],
    });
    const outcome = await runEvalSet({
      set: "excerpts",
      provider,
      options: {},
      thresholds,
      date: "2026-07-11",
      fixtures,
    });
    expect(outcome.verdict.passed).toBe(true);
    expect(outcome.report).toContain("| e-1 | 1.000 |");
  });
});
