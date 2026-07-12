/**
 * Validation PREVIEW for the mapping wizard (issue #134 step 2) — a thin
 * aggregation over {@link validateCsvRow}, the exact row validator the
 * import Workflow (#135) executes. The error side is literally the
 * Workflow's output reshaped, so the preview cannot lie about which rows
 * will be skipped; the preview adds only WARNINGS (empty optional cells),
 * which never affect whether a row imports.
 *
 * Severity vocabulary (issue #134 step 2):
 * - `error`   — the row cannot become a signal and WILL be skipped by the
 *               Workflow (bad date, unreadable rating, nothing to import).
 * - `warning` — an optional mapped column is empty; the row still imports,
 *               just without that detail. Only emitted for rows that pass
 *               (a skipped row's missing details are noise).
 */

import type { ColumnMapping, ImportTargetField } from "@wellregarded/core";

import { validateCsvRow } from "./validateRow.js";

export type CsvPreviewIssueSeverity = "error" | "warning";

export interface CsvPreviewIssue {
  /** 1-based DATA row number (the header row is not counted) — "Row 12". */
  row: number;
  /** The CSV column (header text) the value came from. */
  column: string;
  /** The offending cell value, trimmed ("" when the cell was empty). */
  value: string;
  severity: CsvPreviewIssueSeverity;
  /** Plain language: what is wrong and what to do about it. */
  message: string;
}

export interface CsvPreviewValidation {
  /** How many rows were validated. */
  rowCount: number;
  /** Rows with no error-severity issue (warnings do not fail a row). */
  okCount: number;
  /** Rows the Workflow (#135) would skip. */
  failingRowCount: number;
  issues: CsvPreviewIssue[];
}

/** Optional column-read targets whose empty cells warrant a warning. */
const WARN_WHEN_EMPTY: ReadonlyArray<{
  field: ImportTargetField;
  message: (column: string) => string;
}> = [
  {
    field: "text",
    message: (column) =>
      `The "${column}" column is empty here. The entry imports as a rating without text.`,
  },
  {
    field: "rating",
    message: (column) =>
      `The "${column}" column is empty here. The entry imports without a rating.`,
  },
  {
    field: "author",
    message: (column) =>
      `The "${column}" column is empty here. The entry still imports, just without this detail.`,
  },
  {
    field: "locationHint",
    message: (column) =>
      `The "${column}" column is empty here. The entry still imports, just without this detail.`,
  },
  {
    field: "providerHint",
    message: (column) =>
      `The "${column}" column is empty here. The entry still imports, just without this detail.`,
  },
  {
    field: "patientName",
    message: (column) =>
      `The "${column}" column is empty here. The entry still imports, just without this detail.`,
  },
  {
    field: "patientEmail",
    message: (column) =>
      `The "${column}" column is empty here. The entry still imports, just without this detail.`,
  },
  {
    field: "patientPhone",
    message: (column) =>
      `The "${column}" column is empty here. The entry still imports, just without this detail.`,
  },
];

function emptyCell(
  headers: readonly string[],
  row: readonly string[],
  column: string,
): boolean {
  const index = headers.indexOf(column);
  if (index === -1) return true;
  return (row[index] ?? "").trim() === "";
}

/**
 * Run the Workflow's validator over preview rows and summarize.
 * `firstRowNumber` keeps human row numbers when the caller windows the
 * file. Callers must pre-check `unknownMappingColumns` (same rule as the
 * Workflow, which only ever sees confirmed mappings).
 */
export function validateCsvPreviewRows(
  mapping: ColumnMapping,
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  { firstRowNumber = 1 }: { firstRowNumber?: number } = {},
): CsvPreviewValidation {
  const issues: CsvPreviewIssue[] = [];
  let failingRowCount = 0;

  rows.forEach((row, i) => {
    const rowNumber = firstRowNumber + i;
    const result = validateCsvRow(mapping, headers, row, rowNumber);
    if (!result.ok) {
      failingRowCount += 1;
      for (const error of result.errors) {
        issues.push({
          row: error.rowNumber,
          column: error.column,
          value: error.value.trim(),
          severity: "error",
          message: error.message,
        });
      }
      return;
    }

    for (const { field, message } of WARN_WHEN_EMPTY) {
      const entry = mapping[field];
      if (entry === undefined || !("column" in entry)) continue;
      if (!emptyCell(headers, row, entry.column)) continue;
      issues.push({
        row: rowNumber,
        column: entry.column,
        value: "",
        severity: "warning",
        message: message(entry.column),
      });
    }
  });

  return {
    rowCount: rows.length,
    okCount: rows.length - failingRowCount,
    failingRowCount,
    issues,
  };
}
