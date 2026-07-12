// validateCsvPreviewRows (#134): the wizard's validation preview must be
// the Workflow's validator (validateCsvRow) reshaped — errors identical,
// warnings additive and only on passing rows.
import type { ColumnMapping } from "@wellregarded/core";
import { describe, expect, it } from "vitest";

import { validateCsvPreviewRows } from "./previewValidation.js";
import { validateCsvRow } from "./validateRow.js";

const HEADERS = ["Date", "Stars", "Review", "Reviewer", "Patient Email"];

const MAPPING: ColumnMapping = {
  occurredAt: { column: "Date", dateFormat: "MM/DD/YYYY" },
  rating: { column: "Stars", ratingScale: 5 },
  text: { column: "Review" },
  author: { column: "Reviewer" },
  patientEmail: { column: "Patient Email" },
  visibility: { constant: "private" },
  consentHint: { constant: "imported_unknown" },
};

const GOOD_ROW = ["01/13/2024", "5", "Great cleaning", "Pat L.", "pat@x.com"];

describe("validateCsvPreviewRows", () => {
  it("a clean row produces no issues", () => {
    expect(validateCsvPreviewRows(MAPPING, HEADERS, [GOOD_ROW])).toEqual({
      rowCount: 1,
      okCount: 1,
      failingRowCount: 0,
      issues: [],
    });
  });

  it("error rows carry EXACTLY the Workflow validator's failures", () => {
    const badRow = ["13/45/2023", "9", "ok", "Pat", "pat@x.com"];
    const preview = validateCsvPreviewRows(MAPPING, HEADERS, [badRow], {
      firstRowNumber: 12,
    });

    const direct = validateCsvRow(MAPPING, HEADERS, badRow, 12);
    expect(direct.ok).toBe(false);
    if (direct.ok) throw new Error("unreachable");
    expect(preview.issues).toEqual(
      direct.errors.map((error) => ({
        row: error.rowNumber,
        column: error.column,
        value: error.value.trim(),
        severity: "error",
        message: error.message,
      })),
    );
    expect(preview.failingRowCount).toBe(1);
    expect(preview.okCount).toBe(0);
    // Both failure messages say what to fix, in words.
    expect(preview.issues.map((i) => i.message)).toEqual([
      expect.stringContaining("isn't a date in the format you chose"),
      expect.stringContaining("outside the 5-point scale"),
    ]);
  });

  it("empty optional cells warn on passing rows and never fail them", () => {
    const sparse = ["01/13/2024", "4", "", "", ""];
    const preview = validateCsvPreviewRows(MAPPING, HEADERS, [sparse]);
    expect(preview.failingRowCount).toBe(0);
    expect(preview.okCount).toBe(1);
    expect(preview.issues.map((i) => [i.column, i.severity])).toEqual([
      ["Review", "warning"],
      ["Reviewer", "warning"],
      ["Patient Email", "warning"],
    ]);
    expect(preview.issues[0]?.message).toContain(
      "imports as a rating without text",
    );
  });

  it("failing rows get no warnings — a skipped row's missing details are noise", () => {
    const failing = ["not-a-date", "4", "", "", ""];
    const preview = validateCsvPreviewRows(MAPPING, HEADERS, [failing]);
    expect(preview.failingRowCount).toBe(1);
    expect(preview.issues.every((i) => i.severity === "error")).toBe(true);
  });

  it("summarizes ok vs failing across rows; warnings never fail a row", () => {
    const rows = [
      GOOD_ROW,
      ["13/45/2023", "5", "ok", "Pat", "p@x.com"], // bad date → fails
      ["01/13/2024", "5", "ok", "", "p@x.com"], // empty author → warning only
    ];
    const result = validateCsvPreviewRows(MAPPING, HEADERS, rows);
    expect(result.rowCount).toBe(3);
    expect(result.okCount).toBe(2);
    expect(result.failingRowCount).toBe(1);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(1);
  });

  it("firstRowNumber keeps human row numbers for windowed callers", () => {
    const result = validateCsvPreviewRows(
      MAPPING,
      HEADERS,
      [["", "5", "ok", "Pat", "p@x.com"]],
      { firstRowNumber: 101 },
    );
    expect(result.issues[0]?.row).toBe(101);
  });
});
