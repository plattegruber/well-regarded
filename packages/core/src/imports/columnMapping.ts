/**
 * `ColumnMapping` — the boundary contract between a CSV import's three
 * actors (issue #133, Epic #8): the upload endpoint stores headers and
 * prefills suggestions (`detect.ts`), the mapping wizard (#134) edits this
 * model, and the import Workflow (#135) executes it row by row. Persisted
 * on the `import_drafts` row in `@wellregarded/db` as jsonb.
 *
 * Shape: keyed by TARGET field (what the pipeline needs), each entry
 * naming the CSV column (by header text) that feeds it. Two targets may
 * read the same column — that's the wizard's judgment call, not a schema
 * error. `visibility` and `consentHint` may instead be a `constant`
 * applied to the whole file (the wizard's consent step sets
 * `practice_attested` vs `imported_unknown` in bulk).
 *
 * The one structural rule, encoded as a refinement: a signal needs at
 * least a *when* and a *what* — `occurredAt` is required, and at least one
 * of `text` / `rating` must be mapped.
 *
 * Whether the mapped column names actually exist in the stored headers is
 * validated separately ({@link unknownMappingColumns}) because only the
 * draft row knows its headers.
 */

import { z } from "zod";

import type { ConsentSource } from "../consent/index.js";
import { SIGNAL_VISIBILITIES } from "../signals.js";

/**
 * Date formats the import pipeline can parse (issue #133 requirement 4).
 * `ISO` covers date-only and `T`-separated datetimes (offset or Z);
 * `YYYY-MM-DD HH:mm` is the space-separated export style spreadsheets
 * produce; `epoch_seconds` is a bare integer Unix timestamp.
 */
export const IMPORT_DATE_FORMATS = [
  "ISO",
  "MM/DD/YYYY",
  "DD/MM/YYYY",
  "YYYY-MM-DD HH:mm",
  "epoch_seconds",
] as const;

export type ImportDateFormat = (typeof IMPORT_DATE_FORMATS)[number];

/** Rating scales a CSV column can be on; see `detectRatingScale`. */
export const RATING_SCALES = [5, 10, 100] as const;

export type RatingScale = (typeof RATING_SCALES)[number];

/**
 * Consent context a CSV import can attest — the subset of core's
 * `CONSENT_SOURCES` a source adapter may carry (`patient_link` is excluded
 * because only the patient-link flow itself can produce it; same rule as
 * `SIGNAL_CONSENT_HINTS` in `@wellregarded/sources`). The `satisfies`
 * clause is the drift guard against `consent.ts`.
 */
export const IMPORT_CONSENT_HINTS = [
  "practice_attested",
  "imported_unknown",
] as const satisfies readonly ConsentSource[];

export type ImportConsentHint = (typeof IMPORT_CONSENT_HINTS)[number];

/**
 * Every target field a CSV column can map onto. The names mirror
 * `NormalizedSignal` in `@wellregarded/sources` (occurredAt, rating, …) —
 * the Workflow (#135) translates mapped rows into that contract.
 */
export const IMPORT_TARGET_FIELDS = [
  "occurredAt",
  "rating",
  "text",
  "author",
  "locationHint",
  "providerHint",
  "patientName",
  "patientEmail",
  "patientPhone",
  "visibility",
  "consentHint",
] as const;

export type ImportTargetField = (typeof IMPORT_TARGET_FIELDS)[number];

/**
 * Targets whose values are patient PII. The pipeline routes these to the
 * `pii.*` schema boundary (Epics #3/#6) — they become a `patientHint` on
 * the normalized signal, never columns on `signals` itself.
 */
export const PII_TARGET_FIELDS = [
  "patientName",
  "patientEmail",
  "patientPhone",
] as const satisfies readonly ImportTargetField[];

/** True when values mapped to `field` are PII-destined (`pii.*` routed). */
export function isPiiTarget(field: ImportTargetField): boolean {
  return (PII_TARGET_FIELDS as readonly ImportTargetField[]).includes(field);
}

/** A CSV column reference — the exact header text, as stored on the draft. */
const csvColumn = z.string().min(1, "Name the CSV column for this field.");

const columnRefSchema = z.strictObject({ column: csvColumn });

export const occurredAtMappingSchema = z.strictObject({
  column: csvColumn,
  /** Detected by `detectDateFormat` or wizard-chosen; never silently guessed. */
  dateFormat: z.enum(IMPORT_DATE_FORMATS),
});

export const ratingMappingSchema = z.strictObject({
  column: csvColumn,
  /** Detected by `detectRatingScale` (max observed value); wizard can override. */
  ratingScale: z.union([z.literal(5), z.literal(10), z.literal(100)]),
});

/** Column-mapped, or one constant for the whole file. */
export const visibilityMappingSchema = z.union([
  columnRefSchema,
  z.strictObject({ constant: z.enum(SIGNAL_VISIBILITIES) }),
]);

/** Column-mapped, or one bulk constant set by the wizard's consent step (#134). */
export const consentHintMappingSchema = z.union([
  columnRefSchema,
  z.strictObject({ constant: z.enum(IMPORT_CONSENT_HINTS) }),
]);

export const columnMappingSchema = z
  .strictObject({
    /** Required: when the patient experience happened. */
    occurredAt: occurredAtMappingSchema,
    rating: ratingMappingSchema.optional(),
    text: columnRefSchema.optional(),
    author: columnRefSchema.optional(),
    locationHint: columnRefSchema.optional(),
    providerHint: columnRefSchema.optional(),
    /** PII-destined (see {@link PII_TARGET_FIELDS}). */
    patientName: columnRefSchema.optional(),
    /** PII-destined (see {@link PII_TARGET_FIELDS}). */
    patientEmail: columnRefSchema.optional(),
    /** PII-destined (see {@link PII_TARGET_FIELDS}). */
    patientPhone: columnRefSchema.optional(),
    visibility: visibilityMappingSchema.optional(),
    consentHint: consentHintMappingSchema.optional(),
  })
  .refine(
    (mapping) => mapping.text !== undefined || mapping.rating !== undefined,
    {
      message:
        "Map a text column or a rating column — a signal needs at least " +
        "a when (occurredAt) and a what (text or rating).",
      path: ["text"],
    },
  );

export type ColumnMapping = z.infer<typeof columnMappingSchema>;

/**
 * Every CSV column a mapping reads, by target field. Constant-valued
 * targets (`{ constant: … }`) read no column and are omitted.
 */
export function mappedColumns(
  mapping: ColumnMapping,
): Array<{ field: ImportTargetField; column: string }> {
  const out: Array<{ field: ImportTargetField; column: string }> = [];
  for (const field of IMPORT_TARGET_FIELDS) {
    const entry = mapping[field];
    if (entry !== undefined && "column" in entry) {
      out.push({ field, column: entry.column });
    }
  }
  return out;
}

/**
 * The column references in `mapping` that do NOT exist in `headers` — the
 * check `PUT /imports/csv/:draftId/mapping` runs against the draft's
 * stored headers. Empty array ⇒ the mapping is consistent with the file.
 * Matching is exact (headers are stored exactly as parsed): the wizard
 * picks from the stored list, so any mismatch is a client bug, not a
 * normalization problem.
 */
export function unknownMappingColumns(
  mapping: ColumnMapping,
  headers: readonly string[],
): Array<{ field: ImportTargetField; column: string }> {
  const known = new Set(headers);
  return mappedColumns(mapping).filter(({ column }) => !known.has(column));
}
