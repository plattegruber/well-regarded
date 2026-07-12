/**
 * Privacy-safety judgment — prompt and schema for Layer 2 of the response
 * safety detector (issue #72, Epic #9).
 *
 * Layer 1 (../safety.ts) catches the mechanical disclosures — dates,
 * dollar amounts, procedure names, insurance terms, phone numbers — with
 * regexes. This Haiku-lane call looks for what regexes can't:
 *
 * - **Confirming a care relationship** — "we enjoyed having you as a
 *   patient", "at your last visit", "the treatment plan we discussed".
 *   Even a warm thank-you can disclose that the reviewer was seen here.
 * - **Contradicting the reviewer with private information** — "our
 *   records show you missed two appointments". Using information only
 *   the practice would have both confirms the relationship and discloses
 *   details.
 * - **Defensive / escalating tone** — arguing, blaming, or inviting a
 *   public back-and-forth. A tone problem is never a privacy violation,
 *   so tone findings are warn-only (enforced in ../safety.ts, not by the
 *   model).
 *
 * The model returns verbatim quotes; span mapping (substring search,
 * `span: null` fallback) and severity assignment happen server-side in
 * ../safety.ts — the model reports categories, it never sets levels.
 */

import { z } from "zod";

import type { ClassifyPrompt } from "../provider.js";
import type { ReviewContext } from "../safety-types.js";

/**
 * Stable fixture key for `FakeAiProvider` and the eval harness (#73).
 * Bump the suffix when the prompt or schema changes meaningfully — evals
 * compare like with like by prompt version.
 */
export const SAFETY_PROMPT_NAME = "safety/v1";

/**
 * The categories the model may report. Severity is assigned server-side
 * per category (see `LLM_CATEGORY_LEVELS` in ../safety.ts): the first two
 * block, the last two warn.
 */
export const SAFETY_LLM_CATEGORIES = [
  "confirms_care_relationship",
  "contradicts_reviewer_privately",
  "defensive_tone",
  "invites_public_dispute",
] as const;

export type SafetyLlmCategory = (typeof SAFETY_LLM_CATEGORIES)[number];

/** The forced-tool output schema for the safety judgment call. */
export const SafetyJudgmentSchema = z.object({
  findings: z
    .array(
      z.object({
        category: z.enum(SAFETY_LLM_CATEGORIES),
        /**
         * Verbatim quote of the offending draft text, copied
         * character-for-character; null for a whole-draft finding (e.g.
         * overall tone). Mapped to a span by substring search server-side.
         */
        quote: z.string().min(1).max(300).nullable(),
        /** One line, shown inline to practice staff in the composer. */
        reason: z.string().min(1).max(240),
        /** Optional rewrite hint, also shown inline. */
        suggestion: z.string().min(1).max(240).nullable(),
      }),
    )
    .max(8),
});

export type SafetyJudgment = z.infer<typeof SafetyJudgmentSchema>;

/**
 * System prompt. The safe-response principles come from the product's
 * response guidance (and the Epic #10 drafting prompt): thank the
 * reviewer, never confirm a care relationship, invite private contact,
 * stay calm and brief. Edit deliberately — the eval fixtures in
 * evals/fixtures/safety.jsonl are labeled against this prompt version.
 */
const SAFETY_SYSTEM_PROMPT = `You review draft public replies that a dental practice is about to post under an online review. Patient privacy law means one careless sentence can be a violation: publicly confirming that the reviewer was ever a patient, or referencing anything about their care, is a disclosure — even when the reviewer disclosed it first. Their disclosure is not the practice's permission.

A safe public reply follows four principles:
1. Thank the reviewer for the feedback (or acknowledge it in general terms).
2. Never confirm a care relationship — no "your visit", "your appointment", "your treatment", "having you as a patient", no "we" statements that place the reviewer in the chair.
3. Move specifics to a private channel — "please call our office and ask for our practice manager" is the right move; discussing details publicly is not.
4. Stay calm and brief — never argue, correct, blame, or get defensive, no matter what the review claims.

A separate mechanical checker already flags explicit dates, dollar amounts, procedure names, insurance terms, and phone numbers. Your job is the subtle failures it cannot see. Report a finding for each instance of:

- confirms_care_relationship: the draft treats the reviewer as a known patient — confirms they were seen, references their visits, their history, their treatment, how long they've been coming, or thanks them "as a patient". Generic statements about the practice itself ("we've served this community for 20 years", "comfort matters to us") are fine.
- contradicts_reviewer_privately: the draft disputes the reviewer's account using information only the practice would have — records, appointment history, what happened during a visit, what they were told, what they declined. This both confirms the relationship and discloses details.
- defensive_tone: the draft argues with, blames, shames, or corrects the reviewer, or escalates instead of de-escalating ("that's simply not what happened", "you were rude to our staff").
- invites_public_dispute: the draft invites a public back-and-forth about specifics ("reply here and we'll go through your bill line by line") instead of a private channel. Inviting the reviewer to CALL or contact the office privately is the safe pattern, never a finding.

For each finding: quote the offending text VERBATIM, character-for-character from the draft (or null when the problem is the whole draft, e.g. overall tone), give a one-line reason a busy front-desk person will understand, and where you can, a suggestion for a safer rewrite. Do not report the mechanical categories (explicit dates, dollar figures, procedure names, insurance terms, phone numbers) unless they also fit a category above. An empty findings list means the draft is safe on these dimensions.`;

/** What the prompt needs. `draft` is the reply being checked. */
export interface SafetyPromptInput {
  draft: string;
  review: ReviewContext;
}

/**
 * Build the `ClassifyPrompt` for one safety check. The prompt *name* is
 * constant (`safety/v1`) — never interpolate per-call data into it (it is
 * the FakeAiProvider fixture key).
 */
export function safetyPrompt(input: SafetyPromptInput): ClassifyPrompt {
  const rating =
    input.review.rating === null || input.review.rating === ""
      ? "none"
      : `${input.review.rating} out of 5`;
  const reviewText =
    input.review.text && input.review.text.trim().length > 0
      ? input.review.text
      : "(none)";
  return {
    name: SAFETY_PROMPT_NAME,
    system: SAFETY_SYSTEM_PROMPT,
    user:
      `The review being replied to (rating: ${rating}, visibility: ${input.review.visibility}):\n` +
      `<review>\n${reviewText}\n</review>\n\n` +
      `The practice's draft public reply:\n<draft>\n${input.draft}\n</draft>`,
  };
}
