/**
 * Aspect excerpt extraction — prompt, schema, and the verbatim-substring
 * validator (issue #69, Epic #9).
 *
 * A five-sentence review often covers three topics; proof search and Trust
 * Coverage work at the aspect level, so the classify stage splits
 * multi-topic text into self-contained excerpts, each of which gets its own
 * embedding (#71) and lives in `proof_excerpts`. The hard constraint: the
 * model **selects spans, it never rewrites**. A fabricated or "cleaned up"
 * quote attributed to a patient is a trust violation — exactly what this
 * product exists to prevent — so every excerpt the model returns is
 * validated server-side against the original text and rejected unless it is
 * a true substring.
 *
 * Substring tolerance (documented per the issue):
 * 1. exact `indexOf` match first — the stored text is the original slice;
 * 2. on failure, a normalized match: curly quotes/dashes mapped to their
 *    ASCII forms and runs of whitespace collapsed to a single space, with an
 *    index map back to original offsets. Models routinely normalize “smart”
 *    punctuation and rewrap lines; neither changes a single word, so both
 *    are tolerated — but what gets STORED is always the exact original
 *    characters sliced from `original_text` by offset, never the model's
 *    string;
 * 3. anything else (paraphrase, merged sentences, fixed typos, added or
 *    dropped words) is a violation. The caller retries once with the
 *    violations fed back, then skips still-invalid excerpts (falling back
 *    to the whole text as one excerpt if nothing valid survives).
 */

import { z } from "zod";

import type { ClassifyPrompt } from "../provider.js";

/**
 * Stable fixture key for `FakeAiProvider` and the eval harness (#73).
 * Bump the suffix when the prompt or schema changes meaningfully.
 */
export const EXCERPTS_PROMPT_NAME = "excerpts/v1";

/**
 * Below this word count the model is skipped entirely: the whole original
 * text becomes the single excerpt. A 14-word review is already one
 * quotable aspect; a model call would only add cost and fabrication risk.
 */
export const EXCERPT_MIN_MODEL_WORDS = 15;

/**
 * The forced-tool output schema for the extraction call (issue #69
 * requirement 2). `topic_hint` is a free-text label for debugging/eval
 * only — topics are emergent via embeddings, never an enum.
 */
export const ExcerptsSchema = z.object({
  excerpts: z
    .array(
      z.object({
        text: z.string().min(1),
        topic_hint: z.string().max(60),
      }),
    )
    .min(1)
    .max(8),
});

export type Excerpts = z.infer<typeof ExcerptsSchema>;

/**
 * System prompt (issue #69 requirement 3). The substring rule stays
 * prominent and first — edit the rest freely, never demote it.
 */
const EXCERPTS_SYSTEM_PROMPT = `You will be given the text of one patient review or feedback message for a dental practice. Split it into aspect-level excerpts.

**The single most important rule: every excerpt must be copied verbatim, character-for-character, from the original text. You are selecting spans, not writing. Do not fix typos, do not merge sentences from different places, do not paraphrase, do not add or remove a single character. Output that is not an exact substring will be rejected.**

An excerpt should be self-contained: quotable on its own without the rest of the review ("She explained every step before doing it" works; "and that too" does not). Prefer complete sentences or clauses. One excerpt per distinct aspect (a provider's care, front desk, billing, wait time, facility, outcome...). If the whole text is one topic, return it as one excerpt. Skip filler that carries no aspect ("Anyway, that's my experience."). 1-8 excerpts.

For each excerpt also give a short topic_hint (under 60 characters) naming the aspect it covers — a free-text debugging label, not a taxonomy.`;

/** What the prompt needs from a `signals` row. */
export interface ExcerptsPromptInput {
  /** `signals.original_text` — the caller guarantees non-empty text. */
  text: string;
}

/**
 * Build the `ClassifyPrompt` for one signal. The prompt *name* is constant
 * (`excerpts/v1`) — never interpolate per-call data into it (it is the
 * FakeAiProvider fixture key).
 */
export function excerptsPrompt(input: ExcerptsPromptInput): ClassifyPrompt {
  return {
    name: EXCERPTS_PROMPT_NAME,
    system: EXCERPTS_SYSTEM_PROMPT,
    user: `Review text:\n<signal>\n${input.text}\n</signal>`,
  };
}

/**
 * The one-shot retry prompt after substring violations (issue #69
 * requirement 4): same name (same fixture key), the rejections explained.
 */
export function excerptsRetryPrompt(
  input: ExcerptsPromptInput,
  rejectedTexts: readonly string[],
): ClassifyPrompt {
  const base = excerptsPrompt(input);
  const listed = rejectedTexts
    .map((text) => `- ${JSON.stringify(text)}`)
    .join("\n");
  return {
    ...base,
    user:
      `${base.user}\n\n` +
      `Your previous output was rejected: the following excerpts are NOT ` +
      `exact substrings of the original text (you paraphrased, merged, or ` +
      `edited them):\n${listed}\n` +
      `Try again. Copy each excerpt verbatim, character-for-character, from ` +
      `the text inside <signal> — select spans, do not write.`,
  };
}

/** Word count as the ≥15-word gate sees it (whitespace-delimited tokens). */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * One planned `proof_excerpts` row. `packages/ai` stays DB-free — the
 * classify consumer merges in `signal_id`/`practice_id` and inserts via
 * `@wellregarded/db`. `text` is ALWAYS an exact slice of the original:
 * `original.slice(startOffset, startOffset + text.length) === text`.
 */
export interface PlannedExcerpt {
  text: string;
  startOffset: number;
  /** Free-text debugging label; null for the whole-text fallback. */
  topicHint: string | null;
}

/**
 * The no-model-call path: the whole original text (trimmed — the slice
 * invariant still holds, with `startOffset` pointing past the leading
 * whitespace) as one excerpt.
 */
export function wholeTextExcerpt(original: string): PlannedExcerpt {
  const startOffset = original.length - original.trimStart().length;
  return { text: original.trim(), startOffset, topicHint: null };
}

/** Curly punctuation the models routinely "helpfully" normalize. */
const CHAR_NORMALIZATIONS: Record<string, string> = {
  "‘": "'", // ‘
  "’": "'", // ’
  "‚": "'", // ‚
  "“": '"', // “
  "”": '"', // ”
  "„": '"', // „
  "–": "-", // –
  "—": "-", // —
  " ": " ", // non-breaking space
};

/**
 * Normalize `text` (curly punctuation → ASCII, whitespace runs → one
 * space, trimmed) and, when `withMap`, record which ORIGINAL index each
 * normalized character came from — the map that lets a normalized match be
 * converted back to exact original offsets.
 */
function normalizeWithMap(text: string): {
  normalized: string;
  /** map[i] = index in `text` of the char normalized[i] came from. */
  map: number[];
} {
  let normalized = "";
  const map: number[] = [];
  let pendingSpaceAt = -1;
  for (let i = 0; i < text.length; i++) {
    const raw = text[i] as string;
    const char = CHAR_NORMALIZATIONS[raw] ?? raw;
    if (/\s/.test(char)) {
      // Collapse the run; emit one space lazily so trailing runs vanish.
      if (pendingSpaceAt === -1 && normalized.length > 0) pendingSpaceAt = i;
      continue;
    }
    if (pendingSpaceAt !== -1) {
      normalized += " ";
      map.push(pendingSpaceAt);
      pendingSpaceAt = -1;
    }
    normalized += char;
    map.push(i);
  }
  return { normalized, map };
}

/**
 * Locate one model-returned excerpt inside the original text, or return
 * null when it is not a substring under the documented tolerance. The
 * returned `text` is re-sliced from the ORIGINAL so a normalized match can
 * never smuggle in the model's characters.
 */
export function locateExcerpt(
  original: string,
  excerptText: string,
): { text: string; startOffset: number } | null {
  // 1. Exact match.
  const exact = original.indexOf(excerptText);
  if (exact !== -1) {
    const text = original.slice(exact, exact + excerptText.length);
    return { text, startOffset: exact };
  }

  // 2. Normalized match, mapped back to original offsets.
  const { normalized: normalizedOriginal, map } = normalizeWithMap(original);
  const { normalized: normalizedExcerpt } = normalizeWithMap(excerptText);
  if (normalizedExcerpt.length === 0) return null;
  const found = normalizedOriginal.indexOf(normalizedExcerpt);
  if (found === -1) return null;

  const startOffset = map[found];
  const lastOriginalIndex = map[found + normalizedExcerpt.length - 1];
  if (startOffset === undefined || lastOriginalIndex === undefined) {
    return null;
  }
  return {
    text: original.slice(startOffset, lastOriginalIndex + 1),
    startOffset,
  };
}

/** The split verdict on one model response. */
export interface ExcerptValidation {
  /** Verified excerpts — text is the exact original slice at startOffset. */
  accepted: PlannedExcerpt[];
  /** Model strings that are NOT substrings of the original (fabrications). */
  rejected: string[];
}

/**
 * Server-side validation, not trust (issue #69 requirement 4): verify each
 * returned excerpt against the original, re-slice accepted ones from the
 * original by offset, and report the fabrications for the retry prompt.
 * Duplicate spans (same offset + text) collapse to one row.
 */
export function validateExcerpts(
  original: string,
  excerpts: Excerpts,
): ExcerptValidation {
  const accepted: PlannedExcerpt[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const candidate of excerpts.excerpts) {
    const located = locateExcerpt(original, candidate.text);
    if (!located) {
      rejected.push(candidate.text);
      continue;
    }
    const key = `${located.startOffset}:${located.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push({
      text: located.text,
      startOffset: located.startOffset,
      topicHint: candidate.topic_hint,
    });
  }
  return { accepted, rejected };
}
