// @vitest-environment happy-dom
// ValidationResults (#134 step 2): the honest summary, row numbers with
// plain-language fixes, and the will-be-skipped vs imports-anyway split.

import { cleanup, render, screen, within } from "@testing-library/react";
import type { CsvPreviewValidation } from "@wellregarded/sources";
import { afterEach, describe, expect, it } from "vitest";

import { ValidationResults } from "./validation-results";

afterEach(cleanup);

const VALIDATION: CsvPreviewValidation = {
  rowCount: 50,
  okCount: 47,
  failingRowCount: 3,
  issues: [
    {
      row: 12,
      column: "Date",
      value: "13/45/2023",
      severity: "error",
      message:
        "'13/45/2023' isn't a date in the format you chose (MM/DD/YYYY). Fix the file or pick a different date format.",
    },
    {
      row: 30,
      column: "Reviewer",
      value: "",
      severity: "warning",
      message:
        'The "Reviewer" column is empty here. The entry still imports, just without this detail.',
    },
  ],
};

describe("ValidationResults", () => {
  it("summarizes honestly: ok count, total, and skips", () => {
    render(<ValidationResults validation={VALIDATION} />);
    expect(screen.getByText(/47 of 50 sample rows look good\./)).toBeTruthy();
    expect(screen.getByText(/3 rows would be skipped as-is\./)).toBeTruthy();
  });

  it("shows failing rows with row number and a what-to-fix message, split by severity", () => {
    render(<ValidationResults validation={VALIDATION} />);

    const errors = screen.getByRole("region", {
      name: "Rows that will be skipped",
    });
    expect(within(errors).getByText("12")).toBeTruthy();
    expect(within(errors).getByText("Date")).toBeTruthy();
    expect(
      within(errors).getByText(/isn't a date in the format you chose/),
    ).toBeTruthy();

    const warnings = screen.getByRole("region", {
      name: "Rows with missing details",
    });
    expect(within(warnings).getByText("30")).toBeTruthy();
    expect(
      within(warnings).getByText(/still imports, just without this detail/),
    ).toBeTruthy();
  });

  it("a clean sample says so without inventing drama", () => {
    render(
      <ValidationResults
        validation={{
          rowCount: 50,
          okCount: 50,
          failingRowCount: 0,
          issues: [],
        }}
      />,
    );
    expect(screen.getByText(/50 of 50 sample rows look good\./)).toBeTruthy();
    expect(screen.getByText(/Nothing to flag in the sample/)).toBeTruthy();
  });
});
