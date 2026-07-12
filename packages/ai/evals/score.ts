/**
 * Pure scoring functions for the eval harness (issue #73, Epic #9).
 *
 * Everything in this module is deterministic and side-effect free — no
 * provider, no filesystem, no clock — so it runs in the normal `pnpm test`
 * suite with no API key. The runner (./runner.ts) produces `*CaseResult`
 * rows by calling the live model; tests produce them synthetically.
 *
 * Three scoring modes (issue #73 requirement 3):
 *
 * - **Judgments** — exact match per enum dimension, reported as
 *   per-dimension accuracy. Confidence is scored with tolerance bands
 *   (`confidence_band` on the expected side), never exact match. The
 *   headline "missed-urgent" count (expected high/critical scored medium
 *   or below) is zero-tolerance.
 * - **Excerpts** — span-F1: token-overlap precision/recall between
 *   expected and produced character spans, macro-averaged across cases.
 *   The verbatim-substring invariant is enforced upstream by
 *   `locateExcerpt`; any model output that failed to locate arrives here
 *   as a `verbatimViolation` and is an automatic run failure.
 * - **Safety** — precision/recall on the `block` level, plus the
 *   zero-tolerance rule: any `must_block: true` case scored below block
 *   fails the run regardless of aggregate scores.
 *
 * Threshold semantics (evals/thresholds.json): metrics compare with `>=`
 * (a score exactly at the threshold passes); violation counts compare
 * with `<=` against their `*_max`.
 */

import type { Judgments } from "../src/prompts/judgments.js";
import type { SafetyLevel } from "../src/safety-types.js";

// ---------------------------------------------------------------------------
// Judgments
// ---------------------------------------------------------------------------

export const JUDGMENT_DIMENSIONS = [
  "sentiment",
  "urgency",
  "response_risk",
  "publication_suitability",
] as const;

export type JudgmentDimension = (typeof JUDGMENT_DIMENSIONS)[number];

/** Inclusive `[low, high]` tolerance band for a model confidence. */
export type ConfidenceBand = [number, number];

/** Per-dimension bands: only the listed dimensions are checked. */
export type ConfidenceBandMap = {
  [K in JudgmentDimension]?: ConfidenceBand | undefined;
};

/**
 * The labeled expectation for one judgments case. `confidence_band`
 * accepts either one band applied to every dimension, or per-dimension
 * bands (only the listed dimensions are checked).
 */
export interface JudgmentsExpected {
  sentiment: string;
  urgency: string;
  response_risk: string;
  publication_suitability: string;
  confidence_band?: ConfidenceBand | ConfidenceBandMap | undefined;
}

/** One case after the runner called the model. `actual: null` = call failed. */
export interface JudgmentsCaseResult {
  id: string;
  expected: JudgmentsExpected;
  actual: Judgments | null;
  /** Short description when the call errored (validation, transport...). */
  error?: string;
}

export interface DimensionScore {
  correct: number;
  total: number;
  /** correct / total; 1 for an empty set. */
  accuracy: number;
}

export interface ConfidenceBandViolation {
  id: string;
  dimension: JudgmentDimension;
  confidence: number;
  band: ConfidenceBand;
}

export interface JudgmentsCaseFailure {
  id: string;
  /** Human-readable mismatch summaries, one per failing dimension/band. */
  problems: string[];
  expected: JudgmentsExpected;
  actual: Judgments | null;
  error?: string;
}

export interface JudgmentsScore {
  total: number;
  perDimension: Record<JudgmentDimension, DimensionScore>;
  /**
   * Case ids where expected urgency high/critical came back medium or
   * below (or the call failed) — the headline zero-tolerance number.
   */
  missedUrgent: string[];
  confidenceBand: {
    /** Number of (case, dimension) band checks performed. */
    checked: number;
    violations: ConfidenceBandViolation[];
  };
  failures: JudgmentsCaseFailure[];
}

const URGENT_LEVELS: readonly string[] = ["high", "critical"];

function bandsFor(expected: JudgmentsExpected): ConfidenceBandMap {
  const band = expected.confidence_band;
  if (!band) return {};
  if (Array.isArray(band)) {
    return {
      sentiment: band,
      urgency: band,
      response_risk: band,
      publication_suitability: band,
    };
  }
  return band;
}

/** Score judgments results. Failed calls count as a miss on every dimension. */
export function scoreJudgments(
  results: readonly JudgmentsCaseResult[],
): JudgmentsScore {
  const perDimension = {} as Record<JudgmentDimension, DimensionScore>;
  for (const dimension of JUDGMENT_DIMENSIONS) {
    perDimension[dimension] = {
      correct: 0,
      total: results.length,
      accuracy: 1,
    };
  }
  const missedUrgent: string[] = [];
  const violations: ConfidenceBandViolation[] = [];
  let checked = 0;
  const failures: JudgmentsCaseFailure[] = [];

  for (const result of results) {
    const problems: string[] = [];

    for (const dimension of JUDGMENT_DIMENSIONS) {
      const expectedValue = result.expected[dimension];
      const actualValue = result.actual?.[dimension].value;
      if (actualValue === expectedValue) {
        const score = perDimension[dimension];
        score.correct += 1;
      } else {
        problems.push(
          `${dimension}: expected "${expectedValue}", got ${
            actualValue === undefined ? "(no result)" : `"${actualValue}"`
          }`,
        );
      }
    }

    if (URGENT_LEVELS.includes(result.expected.urgency)) {
      const actualUrgency = result.actual?.urgency.value;
      if (
        actualUrgency === undefined ||
        !URGENT_LEVELS.includes(actualUrgency)
      ) {
        missedUrgent.push(result.id);
        problems.push(
          `MISSED URGENT: expected "${result.expected.urgency}" scored as ${
            actualUrgency === undefined ? "(no result)" : `"${actualUrgency}"`
          }`,
        );
      }
    }

    const bands = bandsFor(result.expected);
    for (const dimension of JUDGMENT_DIMENSIONS) {
      const band = bands[dimension];
      if (!band || !result.actual) continue;
      checked += 1;
      const confidence = result.actual[dimension].confidence;
      const [low, high] = band;
      if (confidence < low || confidence > high) {
        violations.push({ id: result.id, dimension, confidence, band });
        problems.push(
          `${dimension} confidence ${confidence} outside band [${low}, ${high}]`,
        );
      }
    }

    if (problems.length > 0 || result.error !== undefined) {
      failures.push({
        id: result.id,
        problems,
        expected: result.expected,
        actual: result.actual,
        ...(result.error === undefined ? {} : { error: result.error }),
      });
    }
  }

  for (const dimension of JUDGMENT_DIMENSIONS) {
    const score = perDimension[dimension];
    score.accuracy = score.total === 0 ? 1 : score.correct / score.total;
  }

  return {
    total: results.length,
    perDimension,
    missedUrgent,
    confidenceBand: { checked, violations },
    failures,
  };
}

// ---------------------------------------------------------------------------
// Excerpts — span-F1
// ---------------------------------------------------------------------------

/** Half-open character span `[start, end)` into a case's original text. */
export interface CharSpan {
  start: number;
  end: number;
}

export interface ExcerptsCaseResult {
  id: string;
  /** The original review text both span sets index into. */
  text: string;
  expected: CharSpan[];
  /** Located spans of the model's accepted excerpts; null = call failed. */
  produced: CharSpan[] | null;
  /**
   * Model strings that are NOT substrings of the original even after the
   * production retry — each one is a fabrication and an automatic failure.
   */
  verbatimViolations: string[];
  error?: string;
}

export interface SpanF1 {
  precision: number;
  recall: number;
  f1: number;
}

/**
 * Whitespace-delimited tokens of `text` as character spans. Token
 * *positions* (not surface strings) are the identity F1 compares on, so a
 * repeated word only matches once per occurrence.
 */
export function tokenSpans(text: string): CharSpan[] {
  const spans: CharSpan[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

function coveredTokens(
  tokens: readonly CharSpan[],
  spans: readonly CharSpan[],
): Set<number> {
  const covered = new Set<number>();
  tokens.forEach((token, index) => {
    if (
      spans.some((span) => token.start < span.end && token.end > span.start)
    ) {
      covered.add(index);
    }
  });
  return covered;
}

/**
 * Token-overlap precision/recall/F1 between expected and produced spans
 * (issue #73 implementation notes: token sets within character spans, so
 * a valid excerpt that starts one word earlier than the label still
 * scores ~1 instead of 0). Both sides empty = perfect agreement (1);
 * exactly one side empty = total disagreement (0).
 */
export function spanF1(
  text: string,
  expected: readonly CharSpan[],
  produced: readonly CharSpan[],
): SpanF1 {
  const tokens = tokenSpans(text);
  const expectedTokens = coveredTokens(tokens, expected);
  const producedTokens = coveredTokens(tokens, produced);

  if (expectedTokens.size === 0 && producedTokens.size === 0) {
    return { precision: 1, recall: 1, f1: 1 };
  }
  let overlap = 0;
  for (const index of producedTokens) {
    if (expectedTokens.has(index)) overlap += 1;
  }
  const precision =
    producedTokens.size === 0 ? 0 : overlap / producedTokens.size;
  const recall = expectedTokens.size === 0 ? 0 : overlap / expectedTokens.size;
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

export interface ExcerptsCaseFailure {
  id: string;
  problems: string[];
  f1: number;
  error?: string;
}

export interface ExcerptsScore {
  total: number;
  /** Macro averages across cases (failed calls score 0). */
  meanPrecision: number;
  meanRecall: number;
  meanF1: number;
  /** Every fabricated (non-substring) excerpt, by case. */
  verbatimViolations: { id: string; texts: string[] }[];
  /** Per-case F1 for the report. */
  perCase: { id: string; f1: number }[];
  failures: ExcerptsCaseFailure[];
}

/**
 * Threshold below which a single case is listed as a failure in the
 * report (the run-level gate is the MEAN F1 in thresholds.json — this
 * constant only controls report verbosity).
 */
export const EXCERPT_CASE_REPORT_F1 = 0.75;

export function scoreExcerpts(
  results: readonly ExcerptsCaseResult[],
): ExcerptsScore {
  let sumPrecision = 0;
  let sumRecall = 0;
  let sumF1 = 0;
  const verbatimViolations: { id: string; texts: string[] }[] = [];
  const perCase: { id: string; f1: number }[] = [];
  const failures: ExcerptsCaseFailure[] = [];

  for (const result of results) {
    const problems: string[] = [];
    let score: SpanF1 = { precision: 0, recall: 0, f1: 0 };
    if (result.produced === null) {
      problems.push("model call failed — case scores 0");
    } else {
      score = spanF1(result.text, result.expected, result.produced);
    }
    sumPrecision += score.precision;
    sumRecall += score.recall;
    sumF1 += score.f1;
    perCase.push({ id: result.id, f1: score.f1 });

    if (result.verbatimViolations.length > 0) {
      verbatimViolations.push({
        id: result.id,
        texts: [...result.verbatimViolations],
      });
      problems.push(
        `VERBATIM VIOLATION: ${result.verbatimViolations.length} excerpt(s) are not substrings of the original text`,
      );
    }
    if (score.f1 < EXCERPT_CASE_REPORT_F1 && result.produced !== null) {
      problems.push(
        `span F1 ${score.f1.toFixed(2)} below ${EXCERPT_CASE_REPORT_F1}`,
      );
    }
    if (problems.length > 0 || result.error !== undefined) {
      failures.push({
        id: result.id,
        problems,
        f1: score.f1,
        ...(result.error === undefined ? {} : { error: result.error }),
      });
    }
  }

  const count = results.length;
  return {
    total: count,
    meanPrecision: count === 0 ? 1 : sumPrecision / count,
    meanRecall: count === 0 ? 1 : sumRecall / count,
    meanF1: count === 0 ? 1 : sumF1 / count,
    verbatimViolations,
    perCase,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

export interface SafetyExpected {
  level: SafetyLevel;
  /** Zero-tolerance marker: scoring this case below block fails the run. */
  must_block?: boolean | undefined;
}

export interface SafetyCaseResult {
  id: string;
  expected: SafetyExpected;
  /** The full detector's overall level; null = the check failed outright. */
  actual: SafetyLevel | null;
  error?: string;
}

export interface SafetyCaseFailure {
  id: string;
  problems: string[];
  expected: SafetyExpected;
  actual: SafetyLevel | null;
  error?: string;
}

export interface SafetyScore {
  total: number;
  /** Exact-match accuracy on the three-way level. */
  levelAccuracy: number;
  block: {
    expectedBlocks: number;
    producedBlocks: number;
    correctBlocks: number;
    /** correctBlocks / producedBlocks; 1 when nothing was blocked. */
    precision: number;
    /** correctBlocks / expectedBlocks; 1 when no blocks were expected. */
    recall: number;
  };
  /** must_block cases scored below block — zero tolerance, fails the run. */
  missedMustBlock: string[];
  failures: SafetyCaseFailure[];
}

export function scoreSafety(results: readonly SafetyCaseResult[]): SafetyScore {
  let correctLevels = 0;
  let expectedBlocks = 0;
  let producedBlocks = 0;
  let correctBlocks = 0;
  const missedMustBlock: string[] = [];
  const failures: SafetyCaseFailure[] = [];

  for (const result of results) {
    const problems: string[] = [];
    const { expected, actual } = result;

    if (actual === expected.level) correctLevels += 1;
    else {
      problems.push(
        `level: expected "${expected.level}", got ${
          actual === null ? "(no result)" : `"${actual}"`
        }`,
      );
    }
    if (expected.level === "block") expectedBlocks += 1;
    if (actual === "block") {
      producedBlocks += 1;
      if (expected.level === "block") correctBlocks += 1;
    }
    if (expected.must_block && actual !== "block") {
      missedMustBlock.push(result.id);
      problems.push(
        `MISSED BLOCK: must_block case scored ${
          actual === null ? "(no result)" : `"${actual}"`
        }`,
      );
    }
    if (problems.length > 0 || result.error !== undefined) {
      failures.push({
        id: result.id,
        problems,
        expected,
        actual,
        ...(result.error === undefined ? {} : { error: result.error }),
      });
    }
  }

  return {
    total: results.length,
    levelAccuracy: results.length === 0 ? 1 : correctLevels / results.length,
    block: {
      expectedBlocks,
      producedBlocks,
      correctBlocks,
      precision: producedBlocks === 0 ? 1 : correctBlocks / producedBlocks,
      recall: expectedBlocks === 0 ? 1 : correctBlocks / expectedBlocks,
    },
    missedMustBlock,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Shape of evals/thresholds.json. Every key optional — absent = ungated. */
export interface Thresholds {
  judgments?: {
    /** Minimum exact-match accuracy required of EVERY dimension. */
    enum_accuracy_per_dimension?: number;
    /** Maximum tolerated missed-urgent cases (0 = zero tolerance). */
    missed_urgent_max?: number;
    /** Maximum tolerated confidence-band violations. */
    confidence_band_violations_max?: number;
  };
  excerpts?: {
    /** Minimum macro-averaged span F1. */
    span_f1_mean?: number;
    /** Maximum tolerated non-substring excerpts (0 = zero tolerance). */
    verbatim_violations_max?: number;
  };
  safety?: {
    /** Minimum recall on the block level (1.0 = never miss a block). */
    block_recall_min?: number;
    /** Minimum precision on the block level. */
    block_precision_min?: number;
    /** Maximum tolerated missed must_block cases (0 = zero tolerance). */
    missed_must_block_max?: number;
  };
}

/** The gate's verdict: `failures` lists every threshold that was broken. */
export interface ThresholdVerdict {
  passed: boolean;
  failures: string[];
}

const verdict = (failures: string[]): ThresholdVerdict => ({
  passed: failures.length === 0,
  failures,
});

export function evaluateJudgmentsThresholds(
  score: JudgmentsScore,
  thresholds: Thresholds,
): ThresholdVerdict {
  const failures: string[] = [];
  const config = thresholds.judgments ?? {};

  const minAccuracy = config.enum_accuracy_per_dimension;
  if (minAccuracy !== undefined) {
    for (const dimension of JUDGMENT_DIMENSIONS) {
      const { accuracy } = score.perDimension[dimension];
      if (accuracy < minAccuracy) {
        failures.push(
          `judgments: ${dimension} accuracy ${accuracy.toFixed(3)} < ${minAccuracy}`,
        );
      }
    }
  }
  const missedUrgentMax = config.missed_urgent_max;
  if (
    missedUrgentMax !== undefined &&
    score.missedUrgent.length > missedUrgentMax
  ) {
    failures.push(
      `judgments: ${score.missedUrgent.length} missed-urgent case(s) > ${missedUrgentMax} [${score.missedUrgent.join(", ")}]`,
    );
  }
  const bandMax = config.confidence_band_violations_max;
  if (
    bandMax !== undefined &&
    score.confidenceBand.violations.length > bandMax
  ) {
    failures.push(
      `judgments: ${score.confidenceBand.violations.length} confidence-band violation(s) > ${bandMax}`,
    );
  }
  return verdict(failures);
}

export function evaluateExcerptsThresholds(
  score: ExcerptsScore,
  thresholds: Thresholds,
): ThresholdVerdict {
  const failures: string[] = [];
  const config = thresholds.excerpts ?? {};

  const minF1 = config.span_f1_mean;
  if (minF1 !== undefined && score.meanF1 < minF1) {
    failures.push(
      `excerpts: mean span F1 ${score.meanF1.toFixed(3)} < ${minF1}`,
    );
  }
  const violationsMax = config.verbatim_violations_max;
  if (violationsMax !== undefined) {
    const count = score.verbatimViolations.reduce(
      (sum, entry) => sum + entry.texts.length,
      0,
    );
    if (count > violationsMax) {
      failures.push(
        `excerpts: ${count} verbatim violation(s) > ${violationsMax} [${score.verbatimViolations.map((v) => v.id).join(", ")}]`,
      );
    }
  }
  return verdict(failures);
}

export function evaluateSafetyThresholds(
  score: SafetyScore,
  thresholds: Thresholds,
): ThresholdVerdict {
  const failures: string[] = [];
  const config = thresholds.safety ?? {};

  const minRecall = config.block_recall_min;
  if (minRecall !== undefined && score.block.recall < minRecall) {
    failures.push(
      `safety: block recall ${score.block.recall.toFixed(3)} < ${minRecall}`,
    );
  }
  const minPrecision = config.block_precision_min;
  if (minPrecision !== undefined && score.block.precision < minPrecision) {
    failures.push(
      `safety: block precision ${score.block.precision.toFixed(3)} < ${minPrecision}`,
    );
  }
  const missedMax = config.missed_must_block_max;
  if (missedMax !== undefined && score.missedMustBlock.length > missedMax) {
    failures.push(
      `safety: ${score.missedMustBlock.length} missed must_block case(s) > ${missedMax} [${score.missedMustBlock.join(", ")}] — zero tolerance`,
    );
  }
  return verdict(failures);
}
