/**
 * Deterministic urgent-keyword fallback (issue #75 requirement 4).
 *
 * When classification is deferred — kill switch or exhausted budget — the
 * route stage must not go blind on urgency: a patient in pain or a legal
 * threat still has to open recovery work. This is the fallback of last
 * resort: a boring, reviewable keyword list tuned for RECALL on
 * emergencies, legal/regulatory threats, and discrimination. False alarms
 * cost a human ten seconds; a miss is a patient walking away in pain.
 *
 * Matching is case-insensitive and word-boundary aware (no substring hits:
 * "painless" never matches, "urgent" inside "urgently" does not — only the
 * `discriminat-` entry is a deliberate stem). No regex cleverness beyond
 * that, per the issue.
 *
 * A hit produces ONE urgency derivation: value `high`, confidence 0.3
 * (honest — keywords are a weak signal), basis `inferred_text`,
 * `model_version: "keyword-fallback-v1"`. The provenance rules from
 * Epic #9 hold: this is a derivation like any other — reviewable,
 * reversible, outranked by any manual correction, and superseded by the
 * real model's rows once the deferred classification is re-driven.
 */

import type { JudgmentDerivation } from "./prompts/judgments.js";

/**
 * The list (issue #75's initial set — extend as needed, keep it boring).
 * Entries ending in `-` are stems: word-boundary on the left, any suffix
 * on the right (`discriminat-` → discriminate/discrimination/…).
 */
export const URGENT_KEYWORDS = [
  // Medical urgency.
  "emergency",
  "urgent",
  "severe pain",
  "unbearable",
  "bleeding",
  "swelling",
  "infection",
  "infected",
  "abscess",
  "can't eat",
  "can't sleep",
  "ER",
  "emergency room",
  // Legal / regulatory threat.
  "lawyer",
  "attorney",
  "sue",
  "lawsuit",
  "malpractice",
  "report you",
  "board",
  "BBB",
  "refund",
  "fraud",
  // Discrimination / privacy.
  "discriminat-",
  "racist",
  "HIPAA",
  "privacy",
] as const;

/** The provenance tag every fallback derivation carries. */
export const URGENT_KEYWORD_MODEL_VERSION = "keyword-fallback-v1";

/** Honest confidence for a keyword-only urgency signal. */
export const URGENT_KEYWORD_CONFIDENCE = 0.3;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One alternation over the whole list, compiled once. Word boundaries on
 * both ends (`\b` treats the apostrophe in "can't" as internal, which is
 * what we want); stems drop the trailing boundary.
 */
const KEYWORD_PATTERNS: ReadonlyArray<{ keyword: string; re: RegExp }> =
  URGENT_KEYWORDS.map((keyword) => {
    const stem = keyword.endsWith("-");
    const body = escapeRegExp(stem ? keyword.slice(0, -1) : keyword)
      // Phrases match across any whitespace run, not just a single space.
      .replace(/ /g, "\\s+");
    return {
      keyword,
      re: new RegExp(`\\b${body}${stem ? "" : "\\b"}`, "i"),
    };
  });

/**
 * Every list entry the text matches (deduplicated, list order) — empty
 * array = no urgency inferred. Case-insensitive, word-boundary aware.
 */
export function matchUrgentKeywords(text: string): string[] {
  return KEYWORD_PATTERNS.filter(({ re }) => re.test(text)).map(
    ({ keyword }) => keyword,
  );
}

/**
 * The derivation row a keyword hit writes (issue #75 requirement 4's exact
 * contract). Callers pass the non-empty match list from
 * {@link matchUrgentKeywords}; the matched terms go in the rationale so a
 * human reviewing the judgment sees exactly why it exists.
 */
export function keywordUrgencyDerivation(
  matches: readonly string[],
): JudgmentDerivation {
  return {
    dimension: "urgency",
    value: "high",
    confidence: URGENT_KEYWORD_CONFIDENCE,
    basis: "inferred_text",
    modelVersion: URGENT_KEYWORD_MODEL_VERSION,
    rationale: `Deterministic keyword fallback (classification deferred): matched ${matches.join(", ")}.`,
  };
}
