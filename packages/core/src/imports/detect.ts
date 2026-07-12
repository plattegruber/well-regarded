/**
 * Auto-detection helpers for the CSV import wizard (issue #133 req. 5) —
 * pure functions over the preview sample (header + first 50 rows), used
 * by the upload endpoint to prefill the wizard (#134). Suggestions only:
 * the human confirms every mapping; nothing here is executed against the
 * full file (that's the Workflow, #135, after confirmation).
 *
 * The cardinal rule, from the issue: ambiguity is REPORTED, never
 * resolved silently. `01/02/2024`-style data that parses as both
 * `MM/DD/YYYY` and `DD/MM/YYYY` returns `{ ambiguous: [both] }` — the
 * wizard must make the human pick.
 */

import {
  IMPORT_DATE_FORMATS,
  type ImportDateFormat,
  type ImportTargetField,
  type RatingScale,
} from "./columnMapping.js";
import { parseImportDate } from "./parse.js";

// ---------------------------------------------------------------------------
// Date-format detection
// ---------------------------------------------------------------------------

/**
 * `{ format }` when exactly one candidate matches every sampled value;
 * `{ ambiguous }` when several do (wizard must ask); `null` when none do
 * (or there were no non-empty samples).
 */
export type DateFormatDetection =
  | { format: ImportDateFormat }
  | { ambiguous: ImportDateFormat[] }
  | null;

/**
 * Which of the candidate formats parse EVERY non-empty sampled value.
 * One survivor → detected; several → ambiguous (typical for day ≤ 12
 * slash dates, where MM/DD and DD/MM both survive); zero → null.
 *
 * Matching delegates to {@link parseImportDate} — the same parser the
 * validation preview (#134) and the import Workflow (#135) run, so a
 * value that "detects" here can never fail to parse later.
 */
export function detectDateFormat(
  values: readonly string[],
): DateFormatDetection {
  const samples = values.map((v) => v.trim()).filter((v) => v !== "");
  if (samples.length === 0) return null;

  const surviving = IMPORT_DATE_FORMATS.filter((format) =>
    samples.every((value) => parseImportDate(value, format) !== null),
  );
  if (surviving.length === 0) return null;
  const [first, ...rest] = surviving;
  if (first !== undefined && rest.length === 0) return { format: first };
  return { ambiguous: [...surviving] };
}

// ---------------------------------------------------------------------------
// Rating-scale detection
// ---------------------------------------------------------------------------

/**
 * Scale from the max observed value (issue #133 req. 4): ≤5 → 5, ≤10 →
 * 10, ≤100 → 100. Deliberately stricter than "else 100": values over 100
 * (or negative, or non-numeric) mean the column is NOT a rating, so the
 * answer is `null`, not a bad guess. Wizard can always override.
 */
export function detectRatingScale(
  values: readonly string[],
): RatingScale | null {
  const samples = values.map((v) => v.trim()).filter((v) => v !== "");
  if (samples.length === 0) return null;

  let max = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    // Number() (not parseFloat): "4 stars" must not half-parse to 4.
    const value = Number(sample);
    if (!Number.isFinite(value) || value < 0) return null;
    if (value > max) max = value;
  }
  if (max <= 5) return 5;
  if (max <= 10) return 10;
  if (max <= 100) return 100;
  return null;
}

// ---------------------------------------------------------------------------
// Header-name classification
// ---------------------------------------------------------------------------

/**
 * The header-name heuristics, in evaluation order — first match wins, so
 * order is meaning: PII patterns run before the generic buckets ("Patient
 * Name" must not fall through to author), and occurredAt runs before text
 * ("Review Date" is a date, not review text). Word boundaries matter:
 * `\breview\b` deliberately does not match "reviewer".
 *
 * This list is the shared implementation the wizard (#134) presents and
 * documents — extend it here, never fork a second list in the app.
 */
export const HEADER_HEURISTICS: ReadonlyArray<{
  target: ImportTargetField;
  pattern: RegExp;
}> = [
  { target: "patientEmail", pattern: /\be?mail\b/ },
  { target: "patientPhone", pattern: /\b(phone|mobile|cell|telephone)\b/ },
  { target: "patientName", pattern: /\bpatient\b/ },
  {
    target: "occurredAt",
    pattern:
      /\b(date|time|timestamp|occurred|created|posted|submitted|visit|when)\b/,
  },
  { target: "rating", pattern: /\b(rating|ratings|stars?|score|nps)\b/ },
  {
    target: "text",
    pattern:
      /\b(review|comments?|feedback|text|body|message|testimonial|remarks?)\b/,
  },
  { target: "author", pattern: /\b(author|reviewer|name)\b/ },
  {
    target: "locationHint",
    pattern: /\b(location|office|branch|practice|clinic|site)\b/,
  },
  {
    target: "providerHint",
    pattern: /\b(provider|doctor|dentist|dr|clinician|physician|hygienist)\b/,
  },
  { target: "visibility", pattern: /\b(visibility|public|private)\b/ },
  // `opt` covers opt-in/opt-out/opted columns (separators normalize away).
  { target: "consentHint", pattern: /\b(consent|permission|opt)\b/ },
];

/**
 * Headers that describe where a row CAME FROM (issue #134): M1 imports
 * are one source per file, so a source/platform/channel column maps onto
 * nothing — the wizard shows an informational badge instead of a target
 * suggestion. Kept beside {@link HEADER_HEURISTICS} so the vocabulary
 * lives in one place.
 */
export const SOURCE_INFO_HEADER_PATTERN = /\b(source|platform|channel)\b/;

/** True when `header` names the row's origin (badge, not a mapping target). */
export function isSourceInfoHeader(header: string): boolean {
  return SOURCE_INFO_HEADER_PATTERN.test(normalizeHeader(header));
}

/** Lowercase, separators → spaces — so `Review_Date` matches like "review date". */
function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[_\-./()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** First matching heuristic's target, or null for "no suggestion". */
export function classifyHeader(header: string): ImportTargetField | null {
  const normalized = normalizeHeader(header);
  if (normalized === "") return null;
  for (const { target, pattern } of HEADER_HEURISTICS) {
    if (pattern.test(normalized)) return target;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Whole-preview composition
// ---------------------------------------------------------------------------

/** Per-column auto-detection result — the `detected.columns[i]` the upload response returns. */
export interface ColumnDetection {
  /** Column position in the CSV (0-based), aligned with `headers`. */
  index: number;
  header: string;
  /** Header-name suggestion (values may refine it — see `detectColumns`). */
  suggestedTarget: ImportTargetField | null;
  /** Present when `suggestedTarget` is `occurredAt`. */
  dateFormat?: DateFormatDetection;
  /** Present when `suggestedTarget` is `rating`. */
  ratingScale?: RatingScale | null;
}

/**
 * Classify every column of the preview sample. Header names lead; values
 * refine: an occurredAt suggestion gets a date-format detection over the
 * sampled values, a rating suggestion gets a scale detection. A column
 * whose header says nothing but whose values ALL parse as dates is
 * suggested as occurredAt too (epoch_seconds excluded from that fallback
 * — bare numeric columns are too often ids, so only a header can claim
 * epoch).
 */
export function detectColumns(
  headers: readonly string[],
  previewRows: readonly (readonly string[])[],
): ColumnDetection[] {
  return headers.map((header, index) => {
    const values = previewRows.map((row) => row[index] ?? "");
    let suggestedTarget = classifyHeader(header);
    let dateFormat: DateFormatDetection | undefined;
    let ratingScale: RatingScale | null | undefined;

    if (suggestedTarget === null) {
      const fallback = detectDateFormat(values);
      if (
        fallback !== null &&
        !("format" in fallback && fallback.format === "epoch_seconds")
      ) {
        suggestedTarget = "occurredAt";
        dateFormat = fallback;
      }
    } else if (suggestedTarget === "occurredAt") {
      dateFormat = detectDateFormat(values);
    } else if (suggestedTarget === "rating") {
      ratingScale = detectRatingScale(values);
    }

    return {
      index,
      header,
      suggestedTarget,
      ...(dateFormat !== undefined ? { dateFormat } : {}),
      ...(ratingScale !== undefined ? { ratingScale } : {}),
    };
  });
}
