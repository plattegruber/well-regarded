/**
 * The wizard's consent question and confirm guardrail (issue #134, Epic
 * #8) — pure functions over a draft's persisted state. `importStartIssues`
 * is the ONE gate both fronts run before flipping a draft to `confirmed`
 * (the API worker's `start` endpoint and the dashboard's confirm action,
 * via `confirmImportDraft` in @wellregarded/db): the wizard can never
 * confirm a draft the server would reject, because both ask this function.
 *
 * Per-ROW validation is deliberately NOT here: that lives in
 * `@wellregarded/sources` (`validateCsvRow`), because it produces
 * `NormalizedSignal` candidates — this module only judges whether the
 * draft's mapping + consent state is complete enough to start.
 */

import type { SignalVisibility } from "../signals.js";
import {
  type ColumnMapping,
  columnMappingSchema,
  type ImportConsentHint,
  isPiiTarget,
  mappedColumns,
  unknownMappingColumns,
} from "./columnMapping.js";

/**
 * Whether the consent step applies (issue #134 step 3): the file carries
 * private feedback (visibility is the constant `private`, or read per row
 * — unknown rows may be private) or maps any patient PII column. Public
 * reviews with no PII need no consent decision.
 */
export function consentRequiredForMapping(mapping: ColumnMapping): boolean {
  if (mappedColumns(mapping).some(({ field }) => isPiiTarget(field))) {
    return true;
  }
  const visibility = mapping.visibility;
  if (visibility === undefined) return false;
  if ("column" in visibility) return true;
  return visibility.constant === "private";
}

/** The bulk consent choice stored on the mapping, when one was made. */
export function mappingConsentChoice(
  mapping: ColumnMapping,
): ImportConsentHint | null {
  const hint = mapping.consentHint;
  if (hint !== undefined && "constant" in hint) return hint.constant;
  return null;
}

/** The whole-file visibility, when the mapping fixes one. */
export function mappingVisibilityConstant(
  mapping: ColumnMapping,
): SignalVisibility | null {
  const visibility = mapping.visibility;
  if (visibility !== undefined && "constant" in visibility) {
    return visibility.constant;
  }
  return null;
}

export type ImportStartIssueCode =
  | "mapping_missing"
  | "mapping_invalid"
  | "unknown_columns"
  | "visibility_missing"
  | "consent_missing"
  | "attestation_missing";

export interface ImportStartIssue {
  code: ImportStartIssueCode;
  message: string;
}

/**
 * Everything that must be true before a draft may be confirmed. Empty
 * array ⇒ good to go. Stricter than the Workflow's own defaults on
 * purpose: `validateCsvRow` falls back to `private` /
 * `imported_unknown` when a mapping is silent, but the wizard's contract
 * is that a human DECIDED — so an unmapped visibility or an unanswered
 * consent question blocks the start instead of defaulting.
 */
export function importStartIssues(input: {
  mapping: unknown;
  headers: readonly string[];
  attestationNote: string | null;
}): ImportStartIssue[] {
  if (input.mapping === null || input.mapping === undefined) {
    return [
      {
        code: "mapping_missing",
        message: "Map the file's columns before starting the import.",
      },
    ];
  }
  const parsed = columnMappingSchema.safeParse(input.mapping);
  if (!parsed.success) {
    return [
      {
        code: "mapping_invalid",
        message:
          parsed.error.issues[0]?.message ??
          "The column mapping is incomplete. Go back to the mapping step.",
      },
    ];
  }
  const mapping = parsed.data;

  const issues: ImportStartIssue[] = [];
  const unknown = unknownMappingColumns(mapping, input.headers);
  if (unknown.length > 0) {
    issues.push({
      code: "unknown_columns",
      message: `The mapping references columns this file doesn't have: ${unknown
        .map(({ column }) => `"${column}"`)
        .join(", ")}. Go back to the mapping step.`,
    });
  }
  if (mapping.visibility === undefined) {
    issues.push({
      code: "visibility_missing",
      message:
        "Choose whether these entries are public reviews or private feedback before starting.",
    });
  }
  if (consentRequiredForMapping(mapping) && mapping.consentHint === undefined) {
    issues.push({
      code: "consent_missing",
      message:
        "This file includes private feedback or patient details. Answer the consent question before starting.",
    });
  }
  if (
    mappingConsentChoice(mapping) === "practice_attested" &&
    (input.attestationNote === null || input.attestationNote.trim() === "")
  ) {
    issues.push({
      code: "attestation_missing",
      message:
        "Note where the documented permission lives (for example, signed intake forms) before starting.",
    });
  }
  return issues;
}
