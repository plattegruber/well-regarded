/**
 * Eval runner plumbing (issue #73) — everything `run.ts` does except
 * construct the live provider, so all of it is testable with
 * `FakeAiProvider` (tests NEVER call the live API; the live run is the
 * point of `pnpm eval`, not of `pnpm test`).
 *
 * Per set, the runner mirrors production faithfully:
 * - judgments: one `classify` per case with `judgmentsPrompt`, comparing
 *   the RAW model output (before `applyUrgencyFloor` — fixtures label raw
 *   expectations, see evals/README.md).
 * - excerpts: `classify` + `validateExcerpts`, and on any rejected
 *   excerpt the same one-shot `excerptsRetryPrompt` production uses;
 *   whatever is still not a substring after the retry is a verbatim
 *   violation (production would skip it — the eval fails on it instead,
 *   because a prompt that fabricates quotes must not regress in quietly).
 * - safety: the FULL two-layer `checkResponseSafety` (deterministic rules
 *   + live Layer-2 judgment), because fixture levels are labeled against
 *   the whole detector. Degraded mode (model call failed, `llm:skipped`
 *   finding) is recorded as a case error: an eval that silently skipped
 *   the model would be measuring nothing.
 */

import type { z } from "zod";

import {
  AiRequestError,
  AiResponseError,
  AiValidationError,
} from "../src/errors.js";
import {
  ExcerptsSchema,
  excerptsPrompt,
  excerptsRetryPrompt,
  validateExcerpts,
} from "../src/prompts/excerpts.js";
import { JudgmentsSchema, judgmentsPrompt } from "../src/prompts/judgments.js";
import type {
  AiProvider,
  AiResult,
  ClassifyOpts,
  ClassifyPrompt,
} from "../src/provider.js";
import { checkResponseSafety } from "../src/safety.js";
import type {
  ExcerptsFixture,
  JudgmentsFixture,
  SafetyFixture,
} from "./cases.js";
import type {
  ExcerptsCaseResult,
  ExcerptsScore,
  JudgmentsCaseResult,
  JudgmentsScore,
  SafetyCaseResult,
  SafetyScore,
  Thresholds,
  ThresholdVerdict,
} from "./score.js";
import {
  evaluateExcerptsThresholds,
  evaluateJudgmentsThresholds,
  evaluateSafetyThresholds,
  JUDGMENT_DIMENSIONS,
  scoreExcerpts,
  scoreJudgments,
  scoreSafety,
} from "./score.js";

// ---------------------------------------------------------------------------
// Usage accounting
// ---------------------------------------------------------------------------

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** Distinct concrete model ids observed (normally exactly one). */
  models: string[];
}

/**
 * Wraps any `AiProvider` and accumulates usage across calls — the token
 * cost line in the report. `checkResponseSafety` doesn't surface usage,
 * so the wrapper is the one place it can be captured uniformly.
 */
export class UsageRecordingProvider implements AiProvider {
  readonly totals: UsageTotals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    models: [],
  };

  readonly #inner: AiProvider;

  constructor(inner: AiProvider) {
    this.#inner = inner;
  }

  async classify<T>(
    prompt: ClassifyPrompt,
    schema: z.ZodType<T>,
    opts: ClassifyOpts,
  ): Promise<AiResult<T>> {
    const result = await this.#inner.classify(prompt, schema, opts);
    this.totals.calls += 1;
    this.totals.inputTokens += result.usage.inputTokens;
    this.totals.outputTokens += result.usage.outputTokens;
    this.totals.latencyMs += result.usage.latencyMs;
    if (!this.totals.models.includes(result.usage.model)) {
      this.totals.models.push(result.usage.model);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Case selection
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** Run only these fixture ids (`--only`). */
  only?: string[] | undefined;
  /** Run at most N cases after `only` filtering (`--limit`). */
  limit?: number | undefined;
}

/** Apply `--only` / `--limit`. Unknown `--only` ids throw — a typo must not silently pass an empty run. */
export function selectCases<T extends { id: string }>(
  fixtures: readonly T[],
  options: RunOptions,
): T[] {
  let selected = [...fixtures];
  if (options.only && options.only.length > 0) {
    const known = new Set(fixtures.map((fixture) => fixture.id));
    const missing = options.only.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new Error(
        `--only ids not found in fixtures: ${missing.join(", ")}`,
      );
    }
    const wanted = new Set(options.only);
    selected = selected.filter((fixture) => wanted.has(fixture.id));
  }
  if (options.limit !== undefined) {
    selected = selected.slice(0, options.limit);
  }
  return selected;
}

const isAiError = (error: unknown): error is Error =>
  error instanceof AiRequestError ||
  error instanceof AiResponseError ||
  error instanceof AiValidationError;

// ---------------------------------------------------------------------------
// Per-set runners
// ---------------------------------------------------------------------------

export async function runJudgmentsEval(
  provider: AiProvider,
  fixtures: readonly JudgmentsFixture[],
  options: RunOptions = {},
): Promise<JudgmentsCaseResult[]> {
  const results: JudgmentsCaseResult[] = [];
  for (const fixture of selectCases(fixtures, options)) {
    try {
      const result = await provider.classify(
        judgmentsPrompt(fixture.input),
        JudgmentsSchema,
        { purpose: "eval:judgments", practiceId: null, model: "pipeline" },
      );
      results.push({
        id: fixture.id,
        expected: fixture.expected,
        actual: result.value,
      });
    } catch (error) {
      if (!isAiError(error)) throw error;
      results.push({
        id: fixture.id,
        expected: fixture.expected,
        actual: null,
        error: error.message,
      });
    }
  }
  return results;
}

export async function runExcerptsEval(
  provider: AiProvider,
  fixtures: readonly ExcerptsFixture[],
  options: RunOptions = {},
): Promise<ExcerptsCaseResult[]> {
  const results: ExcerptsCaseResult[] = [];
  for (const fixture of selectCases(fixtures, options)) {
    const text = fixture.input.text;
    const expected = fixture.expected.excerpts.map((excerpt) => ({
      start: excerpt.start_offset,
      end: excerpt.start_offset + excerpt.text.length,
    }));
    try {
      const first = await provider.classify(
        excerptsPrompt({ text }),
        ExcerptsSchema,
        { purpose: "eval:excerpts", practiceId: null, model: "pipeline" },
      );
      let validation = validateExcerpts(text, first.value);
      if (validation.rejected.length > 0) {
        // Production's one-shot retry with the violations fed back.
        const retry = await provider.classify(
          excerptsRetryPrompt({ text }, validation.rejected),
          ExcerptsSchema,
          { purpose: "eval:excerpts", practiceId: null, model: "pipeline" },
        );
        validation = validateExcerpts(text, retry.value);
      }
      results.push({
        id: fixture.id,
        text,
        expected,
        produced: validation.accepted.map((excerpt) => ({
          start: excerpt.startOffset,
          end: excerpt.startOffset + excerpt.text.length,
        })),
        verbatimViolations: validation.rejected,
      });
    } catch (error) {
      if (!isAiError(error)) throw error;
      results.push({
        id: fixture.id,
        text,
        expected,
        produced: null,
        verbatimViolations: [],
        error: error.message,
      });
    }
  }
  return results;
}

export async function runSafetyEval(
  provider: AiProvider,
  fixtures: readonly SafetyFixture[],
  options: RunOptions = {},
): Promise<SafetyCaseResult[]> {
  const results: SafetyCaseResult[] = [];
  for (const fixture of selectCases(fixtures, options)) {
    // checkResponseSafety absorbs model failures into degraded mode, so
    // no try/catch here — degraded mode is detected via the llm:skipped
    // finding instead (an eval must not silently skip the model layer).
    const result = await checkResponseSafety(
      fixture.input.draft,
      fixture.input.review,
      { provider, practiceId: null },
    );
    const degraded = result.findings.some(
      (finding) => finding.rule === "llm:skipped",
    );
    results.push({
      id: fixture.id,
      expected: fixture.expected,
      actual: result.level,
      ...(degraded
        ? {
            error: "model call failed — deterministic layer only (llm:skipped)",
          }
        : {}),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Set orchestration
// ---------------------------------------------------------------------------

export const EVAL_SETS = ["judgments", "excerpts", "safety"] as const;
export type EvalSet = (typeof EVAL_SETS)[number];

export interface SetOutcome {
  set: EvalSet;
  verdict: ThresholdVerdict;
  /** The rendered markdown report. */
  report: string;
  /** Filename the report should be written to (no directory). */
  reportFilename: string;
}

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

function reportHeader(input: {
  set: EvalSet;
  promptName: string;
  date: string;
  model: string;
  cases: number;
  totalCases: number;
  verdict: ThresholdVerdict;
  usage: UsageTotals;
}): string[] {
  const lines = [
    `# Eval report: ${input.set}`,
    "",
    `- **Date:** ${input.date}`,
    `- **Model:** ${input.model}`,
    `- **Prompt:** ${input.promptName}`,
    `- **Cases:** ${input.cases}${
      input.cases === input.totalCases
        ? ""
        : ` (of ${input.totalCases} — partial run, do not commit as a baseline)`
    }`,
    `- **Verdict:** ${input.verdict.passed ? "PASS" : "FAIL"}`,
    `- **Cost:** ${input.usage.calls} call(s), ${input.usage.inputTokens} input + ${input.usage.outputTokens} output tokens`,
    "",
  ];
  if (!input.verdict.passed) {
    lines.push("## Threshold failures", "");
    for (const failure of input.verdict.failures) {
      lines.push(`- ${failure}`);
    }
    lines.push("");
  }
  return lines;
}

export interface ReportContext {
  date: string;
  model: string;
  promptName: string;
  totalCases: number;
  usage: UsageTotals;
  thresholds: Thresholds;
}

export function renderJudgmentsReport(
  results: readonly JudgmentsCaseResult[],
  score: JudgmentsScore,
  verdict: ThresholdVerdict,
  context: ReportContext,
): string {
  const lines = reportHeader({
    set: "judgments",
    promptName: context.promptName,
    date: context.date,
    model: context.model,
    cases: results.length,
    totalCases: context.totalCases,
    verdict,
    usage: context.usage,
  });
  lines.push(
    "## Scores",
    "",
    "| dimension | accuracy | correct/total |",
    "|---|---|---|",
  );
  for (const dimension of JUDGMENT_DIMENSIONS) {
    const dimensionScore = score.perDimension[dimension];
    lines.push(
      `| ${dimension} | ${percent(dimensionScore.accuracy)} | ${dimensionScore.correct}/${dimensionScore.total} |`,
    );
  }
  lines.push(
    "",
    `- **Missed-urgent (headline):** ${score.missedUrgent.length}${
      score.missedUrgent.length > 0 ? ` — ${score.missedUrgent.join(", ")}` : ""
    }`,
    `- **Confidence bands:** ${score.confidenceBand.violations.length} violation(s) across ${score.confidenceBand.checked} check(s)`,
    "",
  );
  lines.push(
    ...renderFailures(
      score.failures.map((failure) => ({
        id: failure.id,
        problems: failure.problems,
        expected: failure.expected,
        actual: failure.actual,
        error: failure.error,
      })),
    ),
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderExcerptsReport(
  results: readonly ExcerptsCaseResult[],
  score: ExcerptsScore,
  verdict: ThresholdVerdict,
  context: ReportContext,
): string {
  const lines = reportHeader({
    set: "excerpts",
    promptName: context.promptName,
    date: context.date,
    model: context.model,
    cases: results.length,
    totalCases: context.totalCases,
    verdict,
    usage: context.usage,
  });
  lines.push(
    "## Scores",
    "",
    `- **Mean span F1:** ${score.meanF1.toFixed(3)}`,
    `- **Mean precision:** ${score.meanPrecision.toFixed(3)}`,
    `- **Mean recall:** ${score.meanRecall.toFixed(3)}`,
    `- **Verbatim violations:** ${score.verbatimViolations.reduce((sum, entry) => sum + entry.texts.length, 0)}`,
    "",
    "| case | F1 |",
    "|---|---|",
  );
  for (const entry of score.perCase) {
    lines.push(`| ${entry.id} | ${entry.f1.toFixed(3)} |`);
  }
  lines.push("");
  const byId = new Map(results.map((result) => [result.id, result]));
  lines.push(
    ...renderFailures(
      score.failures.map((failure) => ({
        id: failure.id,
        problems: failure.problems,
        expected: byId.get(failure.id)?.expected ?? null,
        actual: byId.get(failure.id)?.produced ?? null,
        error: failure.error,
      })),
    ),
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderSafetyReport(
  results: readonly SafetyCaseResult[],
  score: SafetyScore,
  verdict: ThresholdVerdict,
  context: ReportContext,
): string {
  const lines = reportHeader({
    set: "safety",
    promptName: context.promptName,
    date: context.date,
    model: context.model,
    cases: results.length,
    totalCases: context.totalCases,
    verdict,
    usage: context.usage,
  });
  lines.push(
    "## Scores",
    "",
    `- **Level accuracy (ok/warn/block):** ${percent(score.levelAccuracy)}`,
    `- **Block precision:** ${score.block.precision.toFixed(3)} (${score.block.correctBlocks}/${score.block.producedBlocks} produced blocks correct)`,
    `- **Block recall:** ${score.block.recall.toFixed(3)} (${score.block.correctBlocks}/${score.block.expectedBlocks} expected blocks caught)`,
    `- **Missed must_block (zero tolerance):** ${score.missedMustBlock.length}${
      score.missedMustBlock.length > 0
        ? ` — ${score.missedMustBlock.join(", ")}`
        : ""
    }`,
    "",
  );
  lines.push(
    ...renderFailures(
      score.failures.map((failure) => ({
        id: failure.id,
        problems: failure.problems,
        expected: failure.expected,
        actual: failure.actual,
        error: failure.error,
      })),
    ),
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

interface FailureLine {
  id: string;
  problems: string[];
  expected: unknown;
  actual: unknown;
  error?: string | undefined;
}

function renderFailures(failures: readonly FailureLine[]): string[] {
  if (failures.length === 0) {
    return ["## Failures", "", "None — every case matched its labels.", ""];
  }
  const lines = ["## Failures", ""];
  for (const failure of failures) {
    lines.push(`### ${failure.id}`, "");
    for (const problem of failure.problems) {
      lines.push(`- ${problem}`);
    }
    if (failure.error !== undefined) {
      lines.push(`- error: ${failure.error}`);
    }
    lines.push(
      "",
      "```json",
      JSON.stringify(
        { expected: failure.expected, actual: failure.actual },
        null,
        2,
      ),
      "```",
      "",
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// One-set entry point (fixture loading + report naming live in run.ts /
// tests so this stays filesystem-free).
// ---------------------------------------------------------------------------

export interface EvalSetInput {
  set: EvalSet;
  provider: AiProvider;
  options: RunOptions;
  thresholds: Thresholds;
  /** ISO date (YYYY-MM-DD) stamped into the report and its filename. */
  date: string;
  fixtures: {
    judgments: readonly JudgmentsFixture[];
    excerpts: readonly ExcerptsFixture[];
    safety: readonly SafetyFixture[];
  };
}

/** Run one golden set end to end: model calls, scoring, gate, report. */
export async function runEvalSet(input: EvalSetInput): Promise<SetOutcome> {
  const usageProvider = new UsageRecordingProvider(input.provider);
  const base = {
    date: input.date,
    usage: usageProvider.totals,
    thresholds: input.thresholds,
  };

  let promptName: string;
  let verdict: ThresholdVerdict;
  let report: string;

  if (input.set === "judgments") {
    const fixtures = input.fixtures.judgments;
    promptName = fixtures[0]?.prompt ?? "judgments/?";
    const results = await runJudgmentsEval(
      usageProvider,
      fixtures,
      input.options,
    );
    const score = scoreJudgments(results);
    verdict = evaluateJudgmentsThresholds(score, input.thresholds);
    report = renderJudgmentsReport(results, score, verdict, {
      ...base,
      promptName,
      model: modelLabel(usageProvider.totals),
      totalCases: fixtures.length,
    });
  } else if (input.set === "excerpts") {
    const fixtures = input.fixtures.excerpts;
    promptName = fixtures[0]?.prompt ?? "excerpts/?";
    const results = await runExcerptsEval(
      usageProvider,
      fixtures,
      input.options,
    );
    const score = scoreExcerpts(results);
    verdict = evaluateExcerptsThresholds(score, input.thresholds);
    report = renderExcerptsReport(results, score, verdict, {
      ...base,
      promptName,
      model: modelLabel(usageProvider.totals),
      totalCases: fixtures.length,
    });
  } else {
    const fixtures = input.fixtures.safety;
    promptName = fixtures[0]?.prompt ?? "safety/?";
    const results = await runSafetyEval(usageProvider, fixtures, input.options);
    const score = scoreSafety(results);
    verdict = evaluateSafetyThresholds(score, input.thresholds);
    report = renderSafetyReport(results, score, verdict, {
      ...base,
      promptName,
      model: modelLabel(usageProvider.totals),
      totalCases: fixtures.length,
    });
  }

  return {
    set: input.set,
    verdict,
    report,
    reportFilename: `${input.set}-${input.date}-${modelLabel(usageProvider.totals)}.md`,
  };
}

/** The concrete model id for the report (and its filename, per the issue). */
function modelLabel(usage: UsageTotals): string {
  if (usage.models.length === 0) return "no-model";
  return usage.models.join("+");
}
