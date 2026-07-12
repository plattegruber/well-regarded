// Mapping-step form parsing (#134): the wizard's step-1 form is dynamic —
// one `column-{i}` select per CSV column, plus inline `dateFormat-{i}` /
// `ratingScale-{i}` and the file-level visibility choice — so it can't run
// through the static-schema `parseForm` helper. This module is the one
// place that turns that form into a `ColumnMapping`, returning the same
// `{ fieldErrors }` shape `Field`-style rendering expects (422, never
// thrown — user mistakes are returned data, per docs/frontend-conventions).
//
// Every message here is read by an office manager: say what to fix, in
// words, sentence case, no exclamation points.

import {
  type ColumnMapping,
  columnMappingSchema,
  IMPORT_DATE_FORMATS,
  IMPORT_TARGET_FIELDS,
  type ImportDateFormat,
  type ImportTargetField,
  RATING_SCALES,
  type RatingScale,
  SIGNAL_VISIBILITIES,
  type SignalVisibility,
} from "@wellregarded/core";

import type { FieldErrors } from "~/lib/forms.server";

/** Human labels for target fields — shared by dropdowns and summaries. */
export const TARGET_FIELD_LABELS: Record<ImportTargetField, string> = {
  occurredAt: "Date",
  rating: "Rating",
  text: "Review text",
  author: "Author name",
  locationHint: "Location",
  providerHint: "Provider",
  patientName: "Patient name",
  patientEmail: "Patient email",
  patientPhone: "Patient phone",
  visibility: "Visibility",
  consentHint: "Consent",
};

/** The mapping dropdown's "leave this column out" value. */
export const DONT_IMPORT = "";

export type ParsedMappingForm =
  | { ok: true; mapping: ColumnMapping }
  | { ok: false; fieldErrors: FieldErrors };

function isTargetField(value: string): value is ImportTargetField {
  return (IMPORT_TARGET_FIELDS as readonly string[]).includes(value);
}

function isDateFormat(value: string): value is ImportDateFormat {
  return (IMPORT_DATE_FORMATS as readonly string[]).includes(value);
}

function isVisibility(value: string): value is SignalVisibility {
  return (SIGNAL_VISIBILITIES as readonly string[]).includes(value);
}

/**
 * Assemble a `ColumnMapping` from the step-1 form. `headers` is the
 * draft's stored header list, in column order — the same order the form
 * rendered its `column-{i}` controls in.
 */
export function parseMappingForm(
  formData: FormData,
  headers: readonly string[],
): ParsedMappingForm {
  const fieldErrors: FieldErrors = {};
  const chosen = new Map<ImportTargetField, number>();
  const mapping: Record<string, unknown> = {};

  headers.forEach((header, i) => {
    const raw = formData.get(`column-${i}`);
    const target = typeof raw === "string" ? raw : DONT_IMPORT;
    if (target === DONT_IMPORT) return;
    if (!isTargetField(target)) {
      fieldErrors[`column-${i}`] = [
        "That isn't a field we know. Pick one from the list.",
      ];
      return;
    }

    const already = chosen.get(target);
    if (already !== undefined) {
      fieldErrors[`column-${i}`] = [
        `"${headers[already]}" is already mapped to ${TARGET_FIELD_LABELS[target].toLowerCase()}. Un-map one of the two columns.`,
      ];
      return;
    }
    chosen.set(target, i);

    if (target === "occurredAt") {
      const rawFormat = formData.get(`dateFormat-${i}`);
      const format = typeof rawFormat === "string" ? rawFormat : "";
      if (!isDateFormat(format)) {
        // The ambiguous-detection case lands here too: the form renders no
        // preselected format, so continuing without an explicit choice is
        // impossible — never a silent guess.
        fieldErrors[`dateFormat-${i}`] = [
          "Choose how these dates should be read before continuing.",
        ];
        return;
      }
      mapping.occurredAt = { column: header, dateFormat: format };
      return;
    }

    if (target === "rating") {
      const rawScale = formData.get(`ratingScale-${i}`);
      const scale = Number(
        typeof rawScale === "string" ? rawScale : Number.NaN,
      );
      if (!(RATING_SCALES as readonly number[]).includes(scale)) {
        fieldErrors[`ratingScale-${i}`] = [
          "Choose the scale these ratings are on.",
        ];
        return;
      }
      mapping.rating = { column: header, ratingScale: scale as RatingScale };
      return;
    }

    if (target === "visibility" || target === "consentHint") {
      mapping[target] = { column: header };
      return;
    }

    mapping[target] = { column: header };
  });

  // File-level visibility: only when no column already carries it. The
  // choice is required — the pipeline can't guess whether a file is
  // public reviews or private feedback.
  if (mapping.visibility === undefined) {
    const rawVisibility = formData.get("visibility");
    const visibility = typeof rawVisibility === "string" ? rawVisibility : "";
    if (isVisibility(visibility)) {
      mapping.visibility = { constant: visibility };
    } else {
      fieldErrors.visibility = [
        "Choose whether these entries are public reviews or private feedback.",
      ];
    }
  }

  // The structural rules, in friendlier words than the schema's. `chosen`
  // (not `mapping`) is the reference: a column that picked occurredAt but
  // still owes its date format already has a column-level error, and a
  // second, form-level complaint would just pile on.
  if (!chosen.has("occurredAt") && fieldErrors[""] === undefined) {
    fieldErrors[""] = [
      "Map a column to date — every entry needs a when. If no column fits, the file can't be imported yet.",
    ];
  } else if (
    !chosen.has("text") &&
    !chosen.has("rating") &&
    fieldErrors[""] === undefined
  ) {
    fieldErrors[""] = [
      "Map a review text or a rating column — without one there'd be nothing to import.",
    ];
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  const parsed = columnMappingSchema.safeParse(mapping);
  if (!parsed.success) {
    // The checks above cover every known way to fail the schema; this is
    // the belt-and-braces net for anything new.
    return {
      ok: false,
      fieldErrors: {
        "": parsed.error.issues.map((issue) => issue.message),
      },
    };
  }
  return { ok: true, mapping: parsed.data };
}
