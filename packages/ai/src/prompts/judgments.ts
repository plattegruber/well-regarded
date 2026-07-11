/**
 * Judgment classification — prompt, schema, and deterministic fallbacks
 * (issue #67, Epic #9).
 *
 * ONE Haiku-lane call per signal returns all four judgments — sentiment,
 * urgency, response risk, publication suitability — each with a confidence
 * and a one-line rationale. Results become `derivations` rows (basis
 * `inferred_text`), never unqualified facts. Everything judgment-shaped
 * lives in this module; the queue consumer in `workers/pipeline` stays
 * thin (fetch signal → call provider → insert rows → enqueue route).
 *
 * Cost model (documented per the issue; see also docs/architecture.md
 * § "The AI layer"): ~1 Haiku call per signal with text. A backfill of
 * 2,000 historical reviews is 2,000 calls — acceptable, but the classify
 * consumer drains through the queue's `max_batch_size`/retry semantics so
 * a big CSV import (Epic #8) trickles rather than slamming the API, and
 * `AnthropicProvider`'s 429 backoff (#63) absorbs bursts. Rating-only
 * signals skip the model entirely (`ratingOnlyDerivations`) — cost
 * matters, and a bare star rating carries no text to classify.
 */

import {
  type DerivationDimension,
  PUBLICATION_SUITABILITIES,
  RESPONSE_RISKS,
  SENTIMENTS,
  type Sentiment,
  URGENCY_LEVELS,
  type UrgencyLevel,
} from "@wellregarded/core";
import { z } from "zod";

import type { ClassifyPrompt } from "../provider.js";

/**
 * Stable fixture key for `FakeAiProvider` and the eval harness (#73).
 * Bump the suffix when the prompt or schema changes meaningfully — evals
 * compare like with like by prompt version.
 */
export const JUDGMENTS_PROMPT_NAME = "judgments/v1";

const confidence = z.number().min(0).max(1);
const rationale = z.string().max(200);

/** One judgment: a value from the dimension's vocabulary + confidence + one-line rationale. */
function judgmentSchema<const T extends readonly [string, ...string[]]>(
  values: T,
) {
  return z.object({
    value: z.enum(values),
    confidence,
    rationale,
  });
}

/**
 * The forced-tool output schema for the judgments call: all four dimensions
 * in one pass. Value vocabularies come from `@wellregarded/core` so
 * dashboard filters (Epics #10/#11) import the same literals.
 */
export const JudgmentsSchema = z.object({
  sentiment: judgmentSchema(SENTIMENTS),
  urgency: judgmentSchema(URGENCY_LEVELS),
  response_risk: judgmentSchema(RESPONSE_RISKS),
  publication_suitability: judgmentSchema(PUBLICATION_SUITABILITIES),
});

export type Judgments = z.infer<typeof JudgmentsSchema>;

/**
 * System prompt. The urgency criteria are safety-relevant — a missed
 * "critical" is a patient in pain — so keep the level definitions
 * exhaustive and edit them deliberately (they came from the issue #67
 * draft and are exercised by the eval fixtures in evals/fixtures/).
 */
const JUDGMENTS_SYSTEM_PROMPT = `You are classifying patient feedback for a healthcare (dental) practice's trust platform. You will be given the original text of one signal (a review, survey response, or note) plus its rating, if any. Return all four judgments in one tool call. Never skip a judgment — when unsure, choose the best value and express the doubt through a lower confidence.

Sentiment — the overall emotional tone toward the practice.
- positive: the author is satisfied; complaints, if any, are trivial asides.
- mixed: genuinely both — real praise AND a real complaint (e.g. loved the dentist, billing was a mess). Mild hedging or lukewarm praise is NOT mixed.
- negative: the author is dissatisfied; praise, if any, is a trivial aside.

Urgency — does this need human attention soon?
- critical: a patient-safety concern; acute pain or post-procedure complications happening right now; threats of violence or self-harm; explicit legal action already underway.
- high: allegations of discrimination; serious billing disputes (sent to collections, claims of insurance fraud); privacy violations (staff discussing a patient, records exposure); a clearly vulnerable patient in distress; threats to escalate publicly or to a regulator.
- medium: an unresolved complaint the practice could still fix (botched scheduling, unreturned calls, a disputed charge); moderate dissatisfaction with a treatment outcome.
- low: a mild complaint, an already-resolved issue, or constructive criticism.
- none: no action implied (positive or neutral feedback).
When parts of the text justify different levels, choose the highest level any part justifies. Judge what the author describes, not how calmly they describe it — a matter-of-fact report of ongoing post-op pain is still critical.

Response risk — if the practice replied publicly, how easy is the reply to get wrong?
- high: replying safely is hard — the text names specific treatments, billing details, or disputes facts, so any substantive reply risks confirming a care relationship or disclosing details.
- medium: a careful, non-specific reply works, but a careless one could acknowledge details the practice must not confirm.
- low: a generic thank-you is safe.

Publication suitability — is this text usable as public proof (with the author's consent)?
- suitable: reads well as public proof.
- unsuitable: contains third-party names, protected health details the author may regret sharing, profanity, or is incoherent.
- needs_review: borderline — a human should decide.

Rate confidence between 0 and 1 for each judgment independently, and give each a one-line rationale (under 200 characters) suitable for showing to practice staff. If the text is empty or just a bare star rating, judge from the rating alone and lower every confidence accordingly.`;

/** What the prompt needs from a `signals` row. */
export interface JudgmentsPromptInput {
  /** `signals.original_text` — may be null or empty. */
  text: string | null;
  /**
   * `signals.original_rating` on the source's own scale (numeric arrives
   * from the DB as a string, e.g. `"4.0"`); null when the source has none.
   */
  rating: string | number | null;
}

/**
 * Build the `ClassifyPrompt` for one signal. The prompt *name* is constant
 * (`judgments/v1`) — never interpolate per-call data into it (it is the
 * FakeAiProvider fixture key).
 */
export function judgmentsPrompt(input: JudgmentsPromptInput): ClassifyPrompt {
  const rating =
    input.rating === null || input.rating === ""
      ? "none"
      : `${input.rating} out of 5`;
  const text =
    input.text && input.text.trim().length > 0 ? input.text : "(none)";
  return {
    name: JUDGMENTS_PROMPT_NAME,
    system: JUDGMENTS_SYSTEM_PROMPT,
    user: `Rating: ${rating}\nSignal text:\n<signal>\n${text}\n</signal>`,
  };
}

/**
 * Below this urgency confidence, the stored urgency is bumped UP one level
 * (issue #67 requirement 5).
 */
export const URGENCY_CONFIDENCE_FLOOR = 0.5;

/**
 * Safety asymmetry (issue #67): when the model's urgency confidence is
 * < 0.5, bump the stored urgency up one level — never down — and keep the
 * model's confidence. A missed urgent complaint is a patient walking away
 * in pain; a false alarm costs a human ten seconds. `critical` stays
 * `critical`; at exactly 0.5 the judgment stands.
 */
export function applyUrgencyFloor(
  value: UrgencyLevel,
  confidence: number,
): UrgencyLevel {
  if (confidence >= URGENCY_CONFIDENCE_FLOOR) return value;
  const index = URGENCY_LEVELS.indexOf(value);
  return (
    URGENCY_LEVELS[Math.min(index + 1, URGENCY_LEVELS.length - 1)] ?? "critical"
  );
}

/**
 * Does this text warrant a model call? Empty/whitespace or fewer than three
 * words (issue #67 requirement 6) is "no meaningful text" — a bare "Great!"
 * or "ok" carries no more signal than the star rating next to it.
 */
export function hasClassifiableText(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.trim().split(/\s+/).filter(Boolean).length >= 3;
}

/**
 * One planned `derivations` row. `packages/ai` stays DB-free — the classify
 * consumer merges in `signal_id`/`practice_id` and inserts via
 * `insertDerivations` in `@wellregarded/db`.
 */
export interface JudgmentDerivation {
  dimension: DerivationDimension;
  value: string;
  confidence: number;
  rationale: string;
  basis: "inferred_text" | "source_metadata";
  /** Concrete model id from the AI result; null for deterministic rows. */
  modelVersion: string | null;
}

/**
 * Map a model result to its four derivation rows: basis `inferred_text`,
 * `model_version` = the concrete model id from the result (never the
 * logical lane name), urgency floored per `applyUrgencyFloor`.
 */
export function judgmentsToDerivations(
  judgments: Judgments,
  modelVersion: string,
): JudgmentDerivation[] {
  const row = (
    dimension: DerivationDimension,
    { value, confidence, rationale }: Judgments[DerivationDimension],
  ): JudgmentDerivation => ({
    dimension,
    value,
    confidence,
    rationale,
    basis: "inferred_text",
    modelVersion,
  });
  return [
    row("sentiment", judgments.sentiment),
    row("urgency", {
      ...judgments.urgency,
      value: applyUrgencyFloor(
        judgments.urgency.value,
        judgments.urgency.confidence,
      ),
    }),
    row("response_risk", judgments.response_risk),
    row("publication_suitability", judgments.publication_suitability),
  ];
}

/** Confidence assigned to rating-derived judgments (issue #67 requirement 6). */
export const RATING_ONLY_CONFIDENCE = 0.6;

/**
 * Deterministic sentiment from a 1–5 star rating: 1–2 negative, 3 mixed,
 * 4–5 positive. Non-integer ratings round half-up (2.5 → mixed); values
 * outside 1–5 clamp.
 */
export function sentimentFromRating(rating: number): Sentiment {
  const rounded = Math.min(5, Math.max(1, Math.round(rating)));
  if (rounded <= 2) return "negative";
  if (rounded === 3) return "mixed";
  return "positive";
}

/**
 * The no-model-call path (issue #67 requirement 6): a signal with no
 * meaningful text but a rating gets deterministic judgments — no Haiku
 * call, cost matters. Basis `source_metadata` (the rating IS the source's
 * metadata), `model_version` null.
 *
 * - sentiment: mapped from the rating, confidence 0.6;
 * - urgency: `none` (`low` for a 1-star — an angry rating with no words
 *   still deserves a glance), confidence 0.6;
 * - publication_suitability: `unsuitable` — there is no text to publish,
 *   so this is a structural fact, confidence 1.
 *
 * `response_risk` is deliberately NOT derived: the dimension judges how
 * hard a public reply to the *text* is, and there is no text — downstream
 * readers treat the missing dimension as unknown.
 */
export function ratingOnlyDerivations(rating: number): JudgmentDerivation[] {
  const stars = Math.min(5, Math.max(1, Math.round(rating)));
  const deterministic = (
    dimension: DerivationDimension,
    value: string,
    confidence: number,
    rationale: string,
  ): JudgmentDerivation => ({
    dimension,
    value,
    confidence,
    rationale,
    basis: "source_metadata",
    modelVersion: null,
  });
  return [
    deterministic(
      "sentiment",
      sentimentFromRating(rating),
      RATING_ONLY_CONFIDENCE,
      `Derived from the ${stars}-star rating; the signal has no text.`,
    ),
    deterministic(
      "urgency",
      stars === 1 ? "low" : "none",
      RATING_ONLY_CONFIDENCE,
      stars === 1
        ? "1-star rating with no text — worth a look, but nothing actionable stated."
        : "Rating only, no text — no action implied.",
    ),
    deterministic(
      "publication_suitability",
      "unsuitable",
      1,
      "No text to publish.",
    ),
  ];
}
