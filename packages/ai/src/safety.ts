/**
 * `checkResponseSafety` — the privacy-disclosure detector for response
 * drafts (issue #72, Epic #9).
 *
 * A practice replying to a public review can violate patient privacy in
 * one sentence: "We're sorry your root canal on March 3rd didn't go as
 * planned" confirms a care relationship and discloses treatment details.
 * The Epic #10 composer (#79) calls this inline (as-you-type warnings)
 * and as the hard publish-time gate.
 *
 * Two layers:
 *
 * - **Layer 1 — deterministic** (`deterministicSafetyChecks`): pure,
 *   synchronous, no model. Regexes and word lists for dates, times,
 *   dollar amounts, procedure vocabulary, care-context nouns, insurance
 *   terms, and phone numbers. Runs even when AI is down; the composer can
 *   run it client-side per keystroke. Every finding carries an exact span.
 * - **Layer 2 — Haiku judgment** (prompt in ./prompts/safety.ts, via
 *   `AiProvider` so tests fake it): the subtle failures no regex catches —
 *   care-relationship confirmation, private contradiction, defensive tone.
 *
 * Combination policy (issue #72 requirement 4): Layer 1 runs first and is
 * authoritative for blocks; Layer 2 only ADDS findings, and the overall
 * level is the max of the finding levels — so the model can raise ok→warn
 * or warn→block but can never lower a deterministic verdict. Tone findings
 * are clamped to warn server-side: a tone problem is never a privacy
 * violation. If the model call fails, the deterministic findings are
 * returned unchanged plus an info-level `ai_check_skipped` notice (the
 * composer surfaces the degraded mode honestly; the level is unaffected).
 *
 * Over-blocking is accepted by design: a false block on "we're open until
 * March" is a cheap edit, a leaked date is not.
 */

import {
  AiRequestError,
  AiResponseError,
  AiValidationError,
} from "./errors.js";
import {
  type SafetyJudgment,
  SafetyJudgmentSchema,
  type SafetyLlmCategory,
  safetyPrompt,
} from "./prompts/safety.js";
import type { AiProvider } from "./provider.js";
import type {
  ReviewContext,
  SafetyFinding,
  SafetyLevel,
  SafetyReasonCode,
  SafetyResult,
  SafetyRule,
} from "./safety-types.js";
import {
  CARE_CONTEXT_TERMS,
  INSURANCE_CARRIERS,
  INSURANCE_TERMS,
  MONTH_NAMES_BARE,
  MONTHS_NEEDING_NUMBER,
  NUMBER_WORDS,
  PROCEDURE_TERMS,
  WEEKDAY_NAMES,
} from "./safety-vocab.js";

// ---------------------------------------------------------------------------
// Matching machinery
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Turn one vocabulary term into a regex fragment: multi-word terms match
 * across whitespace runs, and the last word accepts a simple plural
 * (`crown` → `crowns`) unless the term is already plural.
 */
function termPattern(term: string): string {
  const words = term.split(/\s+/).map(escapeRegExp);
  const joined = words.join("\\s+");
  return term.endsWith("s") ? joined : `${joined}(?:e?s)?`;
}

interface TermMatch extends Span {
  /** The vocabulary entry that matched (not the matched surface text). */
  term: string;
}

/**
 * All non-overlapping vocabulary matches, longest terms first (so "deep
 * cleaning" claims its range before "cleaning" can), returned in text
 * order.
 */
function matchTerms(text: string, terms: readonly string[]): TermMatch[] {
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  const claimed: Span[] = [];
  const matches: TermMatch[] = [];
  for (const term of sorted) {
    const re = new RegExp(`\\b${termPattern(term)}\\b`, "gi");
    for (const match of text.matchAll(re)) {
      const start = match.index;
      const end = start + match[0].length;
      if (claimed.some((c) => start < c.end && end > c.start)) continue;
      claimed.push({ start, end });
      matches.push({ term, start, end });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

/**
 * All non-overlapping matches across `patterns` (earlier patterns win),
 * in text order. `reject` filters out specific surface texts (e.g. the
 * "24/7" idiom, which is not a date).
 */
function matchPatterns(
  text: string,
  patterns: readonly RegExp[],
  reject?: (matched: string) => boolean,
): Span[] {
  const claimed: Span[] = [];
  for (const pattern of patterns) {
    const re = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    );
    for (const match of text.matchAll(re)) {
      if (reject?.(match[0])) continue;
      const start = match.index;
      const end = start + match[0].length;
      if (claimed.some((c) => start < c.end && end > c.start)) continue;
      claimed.push({ start, end });
    }
  }
  return claimed.sort((a, b) => a.start - b.start);
}

/**
 * The "your X" proximity rule (issue #72 implementation notes): the last
 * `WINDOW_TOKENS` word tokens before a match, lowercased. "your" in the
 * window ties the term to the reviewer's own care; "our" marks the
 * practice's own offering ("our whitening options").
 */
const WINDOW_TOKENS = 3;

function tokensBefore(text: string, start: number): string[] {
  const tokens = text
    .slice(0, start)
    .toLowerCase()
    .match(/[a-z']+/g);
  return tokens ? tokens.slice(-WINDOW_TOKENS) : [];
}

function hasYourBefore(text: string, start: number): boolean {
  return tokensBefore(text, start).includes("your");
}

function hasOurBefore(text: string, start: number): boolean {
  return tokensBefore(text, start).includes("our");
}

// ---------------------------------------------------------------------------
// Layer 1 — deterministic rules
// ---------------------------------------------------------------------------

const finding = (
  span: Span,
  rule: SafetyRule,
  code: SafetyReasonCode,
  level: "warn" | "block",
  reason: string,
  suggestion?: string,
): SafetyFinding => ({
  span: { start: span.start, end: span.end },
  rule,
  code,
  reason,
  ...(suggestion === undefined ? {} : { suggestion }),
  level,
});

const alternation = (terms: readonly string[]): string =>
  terms.map(escapeRegExp).join("|");

/** Explicit dates → block. Month names, numeric dates, relative days. */
function dateFindings(text: string): SafetyFinding[] {
  const weekdays = alternation(WEEKDAY_NAMES);
  const patterns: RegExp[] = [
    // Full month names, with optional day and year ("March 3rd", "March
    // 3, 2026", bare "March" — over-blocking accepted).
    new RegExp(
      `\\b(?:${alternation(MONTH_NAMES_BARE)})\\b(?:\\s+\\d{1,2}(?:st|nd|rd|th)?\\b)?(?:,?\\s+\\d{4}\\b)?`,
      "i",
    ),
    // "may" and abbreviations only count with a day or year number.
    new RegExp(
      `\\b(?:${alternation(MONTHS_NEEDING_NUMBER)})\\.?,?\\s+\\d{1,4}(?:st|nd|rd|th)?\\b`,
      "i",
    ),
    // Numeric dates: 3/14, 03/14/2025, 2025-03-14.
    /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/,
    /\b\d{4}-\d{1,2}-\d{1,2}\b/,
    // Relative-day phrases: "last Tuesday", "on Tuesday", "Tuesday's",
    // "Tuesday morning", "yesterday('s)".
    new RegExp(
      `\\b(?:last|this|next|on|every)\\s+(?:${weekdays})\\b(?:'s)?` +
        `|\\b(?:${weekdays})(?:'s)?(?=\\s+(?:morning|afternoon|evening|appointment|visit))` +
        `|\\b(?:${weekdays})'s` +
        `|\\byesterday(?:'s)?\\b`,
      "i",
    ),
  ];
  return matchPatterns(text, patterns, (matched) => matched === "24/7").map(
    (span) =>
      finding(
        span,
        "deterministic:date",
        "appointment_detail",
        "block",
        "Names a specific date or day — a public reply that echoes a date can confirm when the reviewer was seen.",
        "Remove the date entirely; invite them to contact the office privately instead.",
      ),
  );
}

/**
 * Clock times → warn. Office hours are legitimate ("we're open until
 * 5pm"), so a bare time only warns; times attached to the reviewer's care
 * are usually blocked by the date or care-context rules alongside.
 */
function timeFindings(text: string): SafetyFinding[] {
  const patterns: RegExp[] = [
    /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?(?!\w)/i,
    /\b\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)(?!\w)/i,
  ];
  return matchPatterns(text, patterns).map((span) =>
    finding(
      span,
      "deterministic:time",
      "appointment_detail",
      "warn",
      "Mentions a clock time — fine for office hours, but a time tied to the reviewer's visit discloses appointment details.",
      "Keep times to published office hours only; never reference when the reviewer was (or wasn't) seen.",
    ),
  );
}

/** Dollar amounts (numeric or spelled out) → block. */
function dollarFindings(text: string): SafetyFinding[] {
  const numberWord = `(?:${NUMBER_WORDS.join("|")})`;
  const patterns: RegExp[] = [
    /\$\s?\d[\d,]*(?:\.\d{1,2})?/,
    /\b\d[\d,]*(?:\.\d{2})?\s+dollars?\b/i,
    new RegExp(`\\b${numberWord}(?:[\\s-]+${numberWord})*\\s+dollars?\\b`, "i"),
  ];
  return matchPatterns(text, patterns).map((span) =>
    finding(
      span,
      "deterministic:dollar_amount",
      "billing_detail",
      "block",
      "States a dollar amount — billing details about the reviewer must never appear in a public reply.",
      "Remove the amount; billing questions belong in a private conversation with the office.",
    ),
  );
}

/**
 * Procedure vocabulary: "your crown" → block; generic ("we offer crowns")
 * → warn; the practice's own offering ("our whitening options") → fine.
 */
function procedureFindings(text: string): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  for (const match of matchTerms(text, PROCEDURE_TERMS)) {
    if (hasYourBefore(text, match.start)) {
      findings.push(
        finding(
          match,
          "deterministic:procedure",
          "treatment_detail",
          "block",
          `Ties the procedure ("${text.slice(match.start, match.end)}") to the reviewer — confirms their care and discloses treatment details.`,
          "Never reference the reviewer's own treatment; speak only in general terms or move the conversation to a private channel.",
        ),
      );
    } else if (!hasOurBefore(text, match.start)) {
      findings.push(
        finding(
          match,
          "deterministic:procedure",
          "treatment_detail",
          "warn",
          `Names a dental procedure ("${text.slice(match.start, match.end)}") — fine when generic, but any tie to the reviewer's own care is a disclosure.`,
          "Keep procedure mentions generic ('the services we offer'), or drop them.",
        ),
      );
    }
  }
  return findings;
}

/** Reason code per care-context noun (see CARE_CONTEXT_TERMS). */
const CARE_CONTEXT_CODES: Record<string, SafetyReasonCode> = {
  appointment: "confirms_care_relationship",
  visit: "confirms_care_relationship",
  treatment: "treatment_detail",
  "treatment plan": "treatment_detail",
  procedure: "treatment_detail",
  prescription: "treatment_detail",
  medication: "treatment_detail",
  diagnosis: "treatment_detail",
  chart: "phi_identifier",
  records: "phi_identifier",
  file: "phi_identifier",
  balance: "billing_detail",
  account: "billing_detail",
  bill: "billing_detail",
  statement: "billing_detail",
};

/**
 * Care-context nouns: harmless on their own ("call us to book an
 * appointment"), a hard block with a second-person possessive ("your
 * appointment", "your bill") — that single word confirms the care
 * relationship.
 */
function careContextFindings(text: string): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  for (const match of matchTerms(text, CARE_CONTEXT_TERMS)) {
    if (!hasYourBefore(text, match.start)) continue;
    findings.push(
      finding(
        match,
        "deterministic:care_reference",
        CARE_CONTEXT_CODES[match.term] ?? "confirms_care_relationship",
        "block",
        `"Your ${match.term}" confirms the reviewer's care relationship in public.`,
        "Address the feedback without referencing their visit, treatment, or account; invite them to contact the office privately.",
      ),
    );
  }
  return findings;
}

/** Insurance terms and carrier names: warn; block when tied to "your". */
function insuranceFindings(text: string): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  const terms = [...INSURANCE_TERMS, ...INSURANCE_CARRIERS];
  for (const match of matchTerms(text, terms)) {
    const surface = text.slice(match.start, match.end);
    if (hasYourBefore(text, match.start)) {
      findings.push(
        finding(
          match,
          "deterministic:insurance",
          "insurance_detail",
          "block",
          `Ties insurance details ("${surface}") to the reviewer — their coverage and claims must never appear in a public reply.`,
          "Remove the insurance reference; offer to sort it out privately by phone.",
        ),
      );
    } else {
      findings.push(
        finding(
          match,
          "deterministic:insurance",
          "insurance_detail",
          "warn",
          `Mentions insurance ("${surface}") — insurance conversations belong in a private channel, and any tie to the reviewer's own coverage is a disclosure.`,
          "Drop the insurance specifics and invite a private conversation instead.",
        ),
      );
    }
  }
  return findings;
}

/**
 * Phone numbers → warn. A practice's own published number is fine; the
 * check can't know whose number this is, so it warns with exactly that
 * explanation.
 */
function phoneFindings(text: string): SafetyFinding[] {
  const patterns: RegExp[] = [
    /\+1[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/,
    /\(\d{3}\)\s?\d{3}[-.\s]?\d{4}(?!\d)/,
    /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/,
    /\b\d{3}[-.]\d{4}\b/,
  ];
  return matchPatterns(text, patterns).map((span) =>
    finding(
      span,
      "deterministic:phone",
      "phi_identifier",
      "warn",
      "Contains a phone number — the practice's own published number is fine, but the check can't tell whose number this is. Make sure it isn't a personal or patient number.",
    ),
  );
}

/**
 * Layer 1: every deterministic rule, pure and synchronous — no model, no
 * network, no clock. Runs even when AI is down; the composer runs it
 * client-side per keystroke. Findings are in text order (by span start).
 */
export function deterministicSafetyChecks(draftText: string): SafetyFinding[] {
  return [
    ...dateFindings(draftText),
    ...timeFindings(draftText),
    ...dollarFindings(draftText),
    ...procedureFindings(draftText),
    ...careContextFindings(draftText),
    ...insuranceFindings(draftText),
    ...phoneFindings(draftText),
  ].sort((a, b) => (a.span?.start ?? 0) - (b.span?.start ?? 0));
}

// ---------------------------------------------------------------------------
// Layer 2 — Haiku judgment
// ---------------------------------------------------------------------------

/**
 * Severity policy for model-reported categories. The model reports
 * categories, never levels: tone problems are warn-only by design (a tone
 * problem is not a privacy violation), care-relationship confirmation and
 * private contradiction are disclosures and block.
 */
const LLM_CATEGORY_POLICY: Record<
  SafetyLlmCategory,
  { rule: SafetyRule; code: SafetyReasonCode; level: "warn" | "block" }
> = {
  confirms_care_relationship: {
    rule: "llm:care_relationship",
    code: "confirms_care_relationship",
    level: "block",
  },
  contradicts_reviewer_privately: {
    rule: "llm:private_contradiction",
    code: "contradicts_reviewer_privately",
    level: "block",
  },
  defensive_tone: {
    rule: "llm:tone",
    code: "defensive_tone",
    level: "warn",
  },
  invites_public_dispute: {
    rule: "llm:public_dispute",
    code: "invites_public_dispute",
    level: "warn",
  },
};

/**
 * Map one model-returned quote to a span by substring search (exact
 * first, then case-insensitive); `null` when the quote isn't found —
 * a whole-draft finding.
 */
export function quoteToSpan(
  draftText: string,
  quote: string | null,
): { start: number; end: number } | null {
  if (!quote) return null;
  const exact = draftText.indexOf(quote);
  if (exact !== -1) return { start: exact, end: exact + quote.length };
  const relaxed = draftText.toLowerCase().indexOf(quote.toLowerCase());
  if (relaxed !== -1) return { start: relaxed, end: relaxed + quote.length };
  return null;
}

/** Convert the model judgment into findings under the severity policy. */
function llmFindings(
  draftText: string,
  judgment: SafetyJudgment,
): SafetyFinding[] {
  return judgment.findings.map((item) => {
    const policy = LLM_CATEGORY_POLICY[item.category];
    return {
      span: quoteToSpan(draftText, item.quote),
      rule: policy.rule,
      code: policy.code,
      reason: item.reason,
      ...(item.suggestion === null ? {} : { suggestion: item.suggestion }),
      level: policy.level,
    };
  });
}

/** The degraded-mode notice: informational, never changes the level. */
const AI_SKIPPED_FINDING: SafetyFinding = {
  span: null,
  rule: "llm:skipped",
  code: "ai_check_skipped",
  reason:
    "The AI safety check could not run — only the deterministic checks were applied. Subtle problems (confirming a care relationship, contradicting the reviewer, tone) were NOT checked.",
  level: "info",
};

/** Overall level = max of finding levels; `info` never raises it. */
function overallLevel(findings: readonly SafetyFinding[]): SafetyLevel {
  if (findings.some((f) => f.level === "block")) return "block";
  if (findings.some((f) => f.level === "warn")) return "warn";
  return "ok";
}

export interface SafetyCheckDeps {
  /** The AI seam — `AnthropicProvider` in prod, `FakeAiProvider` in tests. */
  provider: AiProvider;
  /** Tenant the Haiku call is billed against; null for tenant-less calls. */
  practiceId: string | null;
  /** Trace id propagated from the caller's execution context. */
  requestId?: string | undefined;
}

/** Cost-log purpose for the Layer-2 call. */
export const SAFETY_PURPOSE = "safety";

/**
 * The full two-layer check. Layer 1 (deterministic) always runs and is
 * authoritative for blocks; Layer 2 (Haiku, `purpose: "safety"`, model
 * lane `"pipeline"`) adds the subtle findings. The overall level is the
 * max across both layers' findings — the model can raise the level, never
 * lower it. When the model call fails (`AiRequestError` /
 * `AiResponseError` / `AiValidationError`), the deterministic result is
 * returned unchanged plus an info-level `ai_check_skipped` notice —
 * deterministic safety never depends on API availability.
 */
export async function checkResponseSafety(
  draftText: string,
  reviewContext: ReviewContext,
  deps: SafetyCheckDeps,
): Promise<SafetyResult> {
  const deterministic = deterministicSafetyChecks(draftText);

  let modelFindings: SafetyFinding[];
  try {
    const result = await deps.provider.classify(
      safetyPrompt({ draft: draftText, review: reviewContext }),
      SafetyJudgmentSchema,
      {
        purpose: SAFETY_PURPOSE,
        practiceId: deps.practiceId,
        model: "pipeline",
        requestId: deps.requestId,
      },
    );
    modelFindings = llmFindings(draftText, result.value);
  } catch (error) {
    if (
      error instanceof AiRequestError ||
      error instanceof AiResponseError ||
      error instanceof AiValidationError
    ) {
      const findings = [...deterministic, AI_SKIPPED_FINDING];
      return { level: overallLevel(findings), findings };
    }
    throw error;
  }

  const findings = [...deterministic, ...modelFindings];
  return { level: overallLevel(findings), findings };
}
