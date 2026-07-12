/**
 * Shared CSV row validation (issue #135, Epic #8) — the ONE code path that
 * turns a raw parsed CSV row plus a confirmed `ColumnMapping` into either a
 * `NormalizedSignal`-shaped candidate or structured, plain-language errors.
 *
 * Shared on purpose (issue #134 requirement 2): the wizard's validation
 * preview endpoint and the import Workflow (#135) both call these exact
 * functions — if they forked, the preview would lie about what the import
 * will do.
 *
 * ROW NUMBERS ARE 1-BASED DATA ROWS, header excluded, everywhere: the
 * upload preview (#133), these errors, the import report (#137), and the
 * deterministic `sourceId` (`sha256(draftId + ":" + rowNumber)`). See
 * {@link FIRST_CSV_DATA_ROW_NUMBER}.
 *
 * Error messages are user-facing copy in the #134 style — say what is
 * wrong AND what to do about it, in words an office manager can act on.
 */

import type {
  ColumnMapping,
  ImportDateFormat,
  RatingScale,
  SignalVisibility,
} from "@wellregarded/core";
import { SIGNAL_VISIBILITIES } from "@wellregarded/core";

import type {
  ConsentHint,
  NormalizedRating,
  NormalizedSignal,
  PatientHint,
} from "../contract/normalizedSignal.js";
import { SIGNAL_CONSENT_HINTS } from "../contract/normalizedSignal.js";

/**
 * The first data row is row 1 — the header row has no number. Every
 * surface that mentions a row (#133 preview, these errors, the #137
 * report, `sourceId` derivation) counts this way; do not introduce a
 * 0-based or header-inclusive count anywhere.
 */
export const FIRST_CSV_DATA_ROW_NUMBER = 1;

/** One structured row-validation failure (issue #135 requirement 2). */
export interface CsvRowError {
  /** 1-based data row (see {@link FIRST_CSV_DATA_ROW_NUMBER}). */
  rowNumber: number;
  /** The CSV column (header text) whose value failed. */
  column: string;
  /** The offending cell value, exactly as parsed. */
  value: string;
  /** Plain-language: what is wrong and what to do about it (#134 style). */
  message: string;
}

/**
 * What a valid row maps to: every source-independent `NormalizedSignal`
 * field EXCEPT `sourceKind`/`sourceId` (the adapter adds those —
 * `sourceId` needs the draft id and an async hash).
 */
export type CsvRowCandidate = Omit<NormalizedSignal, "sourceKind" | "sourceId">;

export type CsvRowValidation =
  | { ok: true; candidate: CsvRowCandidate }
  | { ok: false; errors: CsvRowError[] };

// ---------------------------------------------------------------------------
// Date parsing — applies the wizard's EXPLICIT format choice (#133/#134:
// ambiguity is resolved by a human up front, never re-guessed per row).
// ---------------------------------------------------------------------------

const ISO_DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `T`-separated datetime; offset optional (assumed UTC when absent). */
const ISO_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?$/;
const SLASH_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const SPACE_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const EPOCH_SECONDS_RE = /^\d{9,11}$/;

function utcDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date | null {
  const date = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, ms),
  );
  // Reject rollovers (month 13, Feb 30, ...): the Date must round-trip.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/**
 * Parse one cell using the mapping's explicit `dateFormat`; returns a
 * canonical UTC ISO datetime (what `normalizedSignalSchema.occurredAt`
 * requires) or `null` when the value does not match the chosen format —
 * including the explicit-choice formats (`MM/DD/YYYY` vs `DD/MM/YYYY`)
 * where a mixed-format file makes SOME rows fail cleanly (issue #135
 * requirement 6) rather than being silently mis-read.
 *
 * Values without timezone information (`MM/DD/YYYY`, `DD/MM/YYYY`,
 * `YYYY-MM-DD HH:mm`, offset-less ISO) are interpreted as UTC: a CSV
 * export carries no zone, and a stable wrong-by-hours instant beats a
 * server-local one that changes with the isolate's clock.
 */
export function parseCsvDate(
  value: string,
  format: ImportDateFormat,
): string | null {
  switch (format) {
    case "ISO": {
      const dateOnly = ISO_DATE_ONLY_RE.exec(value);
      if (dateOnly) {
        const date = utcDate(
          Number(dateOnly[1]),
          Number(dateOnly[2]),
          Number(dateOnly[3]),
        );
        return date?.toISOString() ?? null;
      }
      const dt = ISO_DATETIME_RE.exec(value);
      if (!dt) return null;
      // Validate the calendar date before trusting Date's parser.
      if (utcDate(Number(dt[1]), Number(dt[2]), Number(dt[3])) === null) {
        return null;
      }
      const withZone = dt[8] === undefined ? `${value}Z` : value;
      const parsed = new Date(withZone);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    case "MM/DD/YYYY": {
      const m = SLASH_DATE_RE.exec(value);
      if (!m) return null;
      const date = utcDate(Number(m[3]), Number(m[1]), Number(m[2]));
      return date?.toISOString() ?? null;
    }
    case "DD/MM/YYYY": {
      const m = SLASH_DATE_RE.exec(value);
      if (!m) return null;
      const date = utcDate(Number(m[3]), Number(m[2]), Number(m[1]));
      return date?.toISOString() ?? null;
    }
    case "YYYY-MM-DD HH:mm": {
      const m = SPACE_DATETIME_RE.exec(value);
      if (!m) return null;
      const date = utcDate(
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        m[6] === undefined ? 0 : Number(m[6]),
      );
      return date?.toISOString() ?? null;
    }
    case "epoch_seconds": {
      if (!EPOCH_SECONDS_RE.test(value)) return null;
      return new Date(Number(value) * 1000).toISOString();
    }
  }
}

// ---------------------------------------------------------------------------
// Per-field parsers (each returns a value or a plain-language message)
// ---------------------------------------------------------------------------

function parseRating(
  value: string,
  scale: RatingScale,
): { rating: NormalizedRating } | { message: string } {
  // Number() (not parseFloat): "4 stars" must not half-parse to 4.
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return {
      message:
        `'${value}' isn't a number, so it can't be a rating. ` +
        "Fix the value in the file, or map a different column as the rating.",
    };
  }
  if (numeric < 0 || numeric > scale) {
    return {
      message:
        `'${value}' is outside the ${scale}-point scale you chose ` +
        `(ratings must be between 0 and ${scale}). Fix the value or pick ` +
        "a different rating scale.",
    };
  }
  return { rating: { value: numeric, scale } };
}

// Deliberately simple: enough to catch "notes ended up in the email
// column", not RFC 5321. The strict wire schema uses zod's z.email(), so
// this check must be at least as strict for the values it accepts.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseVisibility(value: string): SignalVisibility | null {
  const normalized = value.trim().toLowerCase();
  return (SIGNAL_VISIBILITIES as readonly string[]).includes(normalized)
    ? (normalized as SignalVisibility)
    : null;
}

function parseConsentHint(value: string): ConsentHint | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return (SIGNAL_CONSENT_HINTS as readonly string[]).includes(normalized)
    ? (normalized as ConsentHint)
    : null;
}

// ---------------------------------------------------------------------------
// The row validator
// ---------------------------------------------------------------------------

function cell(
  headers: readonly string[],
  row: readonly string[],
  column: string,
): string {
  const index = headers.indexOf(column);
  if (index === -1) return "";
  return (row[index] ?? "").trim();
}

/**
 * Apply a confirmed mapping to one raw data row.
 *
 * Collects EVERY error on the row (not just the first) so the wizard's
 * validation preview (#134) can show a complete fix list. Empty optional
 * cells are simply omitted (an empty rating cell on a text-mapped row is
 * fine); the row only fails when a REQUIRED value is missing/invalid:
 *
 * - `occurredAt` empty or not parseable in the chosen format;
 * - a non-empty rating/visibility/consent/patient-email cell that doesn't
 *   parse;
 * - neither text nor rating present after mapping (a signal needs a
 *   *what*, mirroring `columnMappingSchema`'s structural rule).
 */
export function validateCsvRow(
  mapping: ColumnMapping,
  headers: readonly string[],
  row: readonly string[],
  rowNumber: number,
): CsvRowValidation {
  const errors: CsvRowError[] = [];
  const fail = (column: string, value: string, message: string) => {
    errors.push({ rowNumber, column, value, message });
  };

  // occurredAt — required (the mapping schema guarantees it is mapped).
  const occurredAtRaw = cell(headers, row, mapping.occurredAt.column);
  let occurredAt: string | null = null;
  if (occurredAtRaw === "") {
    fail(
      mapping.occurredAt.column,
      occurredAtRaw,
      `The '${mapping.occurredAt.column}' cell is empty, and every imported ` +
        "entry needs a date. Fill it in or remove the row.",
    );
  } else {
    occurredAt = parseCsvDate(occurredAtRaw, mapping.occurredAt.dateFormat);
    if (occurredAt === null) {
      fail(
        mapping.occurredAt.column,
        occurredAtRaw,
        `'${occurredAtRaw}' isn't a date in the format you chose ` +
          `(${mapping.occurredAt.dateFormat}). Fix the file or pick a ` +
          "different date format.",
      );
    }
  }

  // rating — optional column; a non-empty cell must parse on the scale.
  let rating: NormalizedRating | null = null;
  if (mapping.rating !== undefined) {
    const raw = cell(headers, row, mapping.rating.column);
    if (raw !== "") {
      const parsed = parseRating(raw, mapping.rating.ratingScale);
      if ("message" in parsed) {
        fail(mapping.rating.column, raw, parsed.message);
      } else {
        rating = parsed.rating;
      }
    }
  }

  // text — optional column; empty stays null (rating-only rows are valid).
  let originalText: string | null = null;
  if (mapping.text !== undefined) {
    const raw = cell(headers, row, mapping.text.column);
    if (raw !== "") originalText = raw;
  }

  if (originalText === null && rating === null && errors.length === 0) {
    const column = mapping.text?.column ?? mapping.rating?.column ?? "";
    fail(
      column,
      "",
      "This row has no review text and no rating — there's nothing to " +
        "import. Fill one of them in or remove the row.",
    );
  }

  const authorRaw =
    mapping.author === undefined
      ? ""
      : cell(headers, row, mapping.author.column);

  // PII columns → patientHint (issue #135 requirement 3): destined for the
  // pii.* boundary downstream, never columns on `signals`.
  const patientHint: PatientHint = {};
  if (mapping.patientName !== undefined) {
    const raw = cell(headers, row, mapping.patientName.column);
    if (raw !== "") patientHint.name = raw;
  }
  if (mapping.patientEmail !== undefined) {
    const raw = cell(headers, row, mapping.patientEmail.column);
    if (raw !== "") {
      if (EMAIL_RE.test(raw)) {
        patientHint.email = raw;
      } else {
        fail(
          mapping.patientEmail.column,
          raw,
          `'${raw}' doesn't look like an email address. Fix the value or ` +
            "map a different column as the patient email.",
        );
      }
    }
  }
  if (mapping.patientPhone !== undefined) {
    const raw = cell(headers, row, mapping.patientPhone.column);
    if (raw !== "") patientHint.phone = raw;
  }
  const hasPatientHint =
    patientHint.name !== undefined ||
    patientHint.email !== undefined ||
    patientHint.phone !== undefined;

  // visibility — column-mapped or one bulk constant; defaults to `private`
  // (Epic #8: an imported file is internal feedback unless the wizard says
  // otherwise).
  let visibility: SignalVisibility = "private";
  if (mapping.visibility !== undefined) {
    if ("constant" in mapping.visibility) {
      visibility = mapping.visibility.constant;
    } else {
      const raw = cell(headers, row, mapping.visibility.column);
      if (raw !== "") {
        const parsed = parseVisibility(raw);
        if (parsed === null) {
          fail(
            mapping.visibility.column,
            raw,
            `'${raw}' isn't a visibility we recognize — use 'public' or ` +
              "'private'. Fix the value, or set one visibility for the " +
              "whole file instead.",
          );
        } else {
          visibility = parsed;
        }
      }
    }
  }

  // consentHint — column-mapped or the wizard's bulk consent choice;
  // defaults to `imported_unknown` (the epic's structural rule: no
  // documented consent ⇒ analyzable, never publishable).
  let consentHint: ConsentHint = "imported_unknown";
  if (mapping.consentHint !== undefined) {
    if ("constant" in mapping.consentHint) {
      consentHint = mapping.consentHint.constant;
    } else {
      const raw = cell(headers, row, mapping.consentHint.column);
      if (raw !== "") {
        const parsed = parseConsentHint(raw);
        if (parsed === null) {
          fail(
            mapping.consentHint.column,
            raw,
            `'${raw}' isn't a consent state we recognize — use ` +
              "'practice_attested' or 'imported_unknown'. Fix the value, " +
              "or set one consent choice for the whole file instead.",
          );
        } else {
          consentHint = parsed;
        }
      }
    }
  }

  const providerRaw =
    mapping.providerHint === undefined
      ? ""
      : cell(headers, row, mapping.providerHint.column);
  const locationRaw =
    mapping.locationHint === undefined
      ? ""
      : cell(headers, row, mapping.locationHint.column);

  if (errors.length > 0) return { ok: false, errors };

  const candidate: CsvRowCandidate = {
    visibility,
    // errors.length === 0 implies occurredAt parsed above.
    occurredAt: occurredAt as string,
    originalText,
    rating,
    authorDisplayName: authorRaw === "" ? null : authorRaw,
    authorExternalId: null,
    sourceUrl: null,
    consentHint,
    ...(hasPatientHint ? { patientHint } : {}),
    // CSV columns are structured data, not prose — source_metadata basis.
    ...(providerRaw !== ""
      ? {
          providerHint: {
            text: providerRaw,
            basis: "source_metadata" as const,
          },
        }
      : {}),
    ...(locationRaw !== ""
      ? {
          locationHint: {
            text: locationRaw,
            basis: "source_metadata" as const,
          },
        }
      : {}),
  };
  return { ok: true, candidate };
}

// ---------------------------------------------------------------------------
// Deterministic source identity
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/**
 * `sourceId` for one CSV row: `sha256(draftId + ":" + rowNumber)` (issue
 * #135 requirement 3). Stable across re-runs and resumes of the SAME
 * draft — that is what makes re-enqueueing a batch after a Workflow
 * resume safe under the `(practice_id, source_kind, source_id)` unique
 * constraint. A re-uploaded corrected file is a NEW draft with new ids;
 * cross-draft duplicates are exactly what the fuzzy dedupe (#106) flags.
 *
 * Web Crypto only: this runs in workers (same rule as rawArtifacts.ts).
 */
export async function csvRowSourceId(
  draftId: string,
  rowNumber: number,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${draftId}:${rowNumber}`),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
