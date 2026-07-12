/**
 * Value parsers for the CSV import wizard's SUGGESTION side (issue #134,
 * Epic #8): `detect.ts` uses these to detect date formats over the
 * preview sample, and the wizard renders "01/02/2024 → January 2, 2024"
 * sample readings with them. Acceptance matches the Workflow's execution
 * parser (`parseCsvDate` in @wellregarded/sources) except that
 * `epoch_seconds` here is bounded to 1995–2035 — detection must be
 * STRICTER than execution (a suggested format that later fails would make
 * the preview lie; the reverse is safe), and without the bound any 9–11
 * digit id column would "detect" as a timestamp.
 *
 * Row validation itself — what the validation preview (#134) and the
 * import Workflow (#135) run — lives in `@wellregarded/sources`
 * (`validateCsvRow`), which produces `NormalizedSignal` candidates and
 * therefore cannot live in core.
 */

import type { ImportDateFormat, RatingScale } from "./columnMapping.js";

function utcCalendarDate(
  year: number,
  month: number,
  day: number,
): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}

/** Date-only or `T`-separated datetime, optional seconds/fraction/offset. */
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const SLASH_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** Space-separated spreadsheet datetime, optional seconds. */
const SPACE_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;

/**
 * Bare integer Unix timestamps, bounded to 1995–2035. The bound is doing
 * real work: without it any 9–11 digit number (phone numbers, order ids)
 * would "parse", and a wrong silent match here poisons every row.
 */
const EPOCH_MIN = Date.UTC(1995, 0, 1) / 1000;
const EPOCH_MAX = Date.UTC(2035, 0, 1) / 1000;
const EPOCH_RE = /^\d{9,11}$/;

/**
 * Parse one trimmed cell value under an explicitly chosen date format.
 * Returns `null` for anything that does not parse EXACTLY under that
 * format — a `null` here is what the wizard's validation preview reports
 * and what the Workflow (#135) counts as a skipped row.
 *
 * Date-only and space-separated values are read as UTC: legacy exports
 * carry no timezone, and a stable, documented choice beats a per-runtime
 * local-time guess.
 */
export function parseImportDate(
  value: string,
  format: ImportDateFormat,
): Date | null {
  const v = value.trim();
  if (v === "") return null;
  switch (format) {
    case "ISO": {
      const m = ISO_RE.exec(v);
      if (!m) return null;
      if (utcCalendarDate(Number(m[1]), Number(m[2]), Number(m[3])) === null) {
        return null;
      }
      // Offset-less datetimes read as UTC — same policy as the Workflow's
      // parseCsvDate (@wellregarded/sources): a CSV carries no zone, and a
      // stable instant beats a server-local one.
      const withZone = m[4] !== undefined && m[7] === undefined ? `${v}Z` : v;
      const date = new Date(withZone);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    case "MM/DD/YYYY": {
      const m = SLASH_RE.exec(v);
      if (!m) return null;
      return utcCalendarDate(Number(m[3]), Number(m[1]), Number(m[2]));
    }
    case "DD/MM/YYYY": {
      const m = SLASH_RE.exec(v);
      if (!m) return null;
      return utcCalendarDate(Number(m[3]), Number(m[2]), Number(m[1]));
    }
    case "YYYY-MM-DD HH:mm": {
      const m = SPACE_DATETIME_RE.exec(v);
      if (!m) return null;
      const date = utcCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
      if (date === null) return null;
      date.setUTCHours(Number(m[4]), Number(m[5]), Number(m[7] ?? 0));
      return date;
    }
    case "epoch_seconds": {
      if (!EPOCH_RE.test(v)) return null;
      const seconds = Number(v);
      if (seconds < EPOCH_MIN || seconds > EPOCH_MAX) return null;
      return new Date(seconds * 1000);
    }
  }
}

/**
 * Parse one trimmed cell value as a rating on the chosen scale. `null`
 * for non-numeric values ("4 stars" must not half-parse) and for values
 * outside `[0, scale]` — 0 is legitimate on NPS-style scales.
 */
export function parseImportRating(
  value: string,
  scale: RatingScale,
): number | null {
  const v = value.trim();
  if (v === "") return null;
  // Number() (not parseFloat): "4 stars" must not half-parse to 4.
  const rating = Number(v);
  if (!Number.isFinite(rating)) return null;
  if (rating < 0 || rating > scale) return null;
  return rating;
}
