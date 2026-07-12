/**
 * Shared types for the privacy-disclosure detector (issue #72).
 *
 * Split from ./safety.ts so the Layer-2 prompt module
 * (./prompts/safety.ts) can import `ReviewContext` without a circular
 * import. The Epic #10 composer (#79) consumes `SafetyResult` for inline
 * warnings and the publish-time gate.
 */

/**
 * What the safety check knows about the review being replied to — review
 * text, rating, visibility. NEVER patient PII: the check guards a public
 * reply, so it must not itself become a disclosure channel.
 */
export interface ReviewContext {
  /** The review's original text; null/empty for rating-only reviews. */
  text: string | null;
  /** Rating on the source's own scale (DB numerics arrive as strings). */
  rating: string | number | null;
  /** `signals.visibility` — public reviews carry the real disclosure risk. */
  visibility: "public" | "private";
}

/**
 * The typed reason-code vocabulary. Every finding carries one, so the
 * composer can group, style, and explain findings without parsing rule
 * strings. Extend deliberately — codes are shown-to-staff taxonomy.
 */
export const SAFETY_REASON_CODES = [
  /** Confirms the reviewer was/is a patient ("having you as a patient"). */
  "confirms_care_relationship",
  /** Names a treatment/procedure as the reviewer's own ("your crown"). */
  "treatment_detail",
  /** Dollar amounts, charges, balances. */
  "billing_detail",
  /** Insurance terms, claims, carriers. */
  "insurance_detail",
  /** Dates, times, visit references — appointment specifics. */
  "appointment_detail",
  /** Identifiers (phone numbers, record references). */
  "phi_identifier",
  /** Disputes the reviewer using information only the practice has. */
  "contradicts_reviewer_privately",
  /** Invites a public back-and-forth instead of a private channel. */
  "invites_public_dispute",
  /** Argumentative / escalating tone (never a block by itself). */
  "defensive_tone",
  /** Informational: the AI layer was skipped (degraded mode). */
  "ai_check_skipped",
] as const;

export type SafetyReasonCode = (typeof SAFETY_REASON_CODES)[number];

/**
 * Which check produced a finding, e.g. `"deterministic:date"` or
 * `"llm:care_relationship"`. Deterministic rule ids name the rule family;
 * llm rule ids name the model-reported category (plus `"llm:skipped"` for
 * the degraded-mode notice).
 */
export type SafetyRule = `deterministic:${string}` | `llm:${string}`;

/** Overall verdict for a draft. */
export type SafetyLevel = "ok" | "warn" | "block";

/**
 * Per-finding level. `"info"` exists ONLY for the degraded-mode
 * `ai_check_skipped` notice — it surfaces in the composer but never
 * raises the overall level (the issue requires the notice to leave the
 * level unchanged). Real safety findings are always warn or block.
 */
export type SafetyFindingLevel = "info" | "warn" | "block";

export interface SafetyFinding {
  /** Offsets into the draft text; null = whole-draft finding. */
  span: { start: number; end: number } | null;
  /** Which check fired, e.g. "deterministic:date", "llm:care_relationship". */
  rule: SafetyRule;
  /** Typed reason code — the composer's grouping/styling key. */
  code: SafetyReasonCode;
  /** Human-readable, shown inline in the composer. */
  reason: string;
  /** Optional rewrite hint. */
  suggestion?: string;
  level: SafetyFindingLevel;
}

export interface SafetyResult {
  /**
   * Max of the finding levels (info counts as ok). Deterministic blocks
   * are authoritative; the LLM layer can only add findings — i.e. raise,
   * never lower.
   */
  level: SafetyLevel;
  findings: SafetyFinding[];
}
