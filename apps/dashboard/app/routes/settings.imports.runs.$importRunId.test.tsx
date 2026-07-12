// Rendering tests for the import report (#137): status states (running /
// completed / completed_with_errors / failed / stale), the counts tiles,
// error-table pagination and the cap-honesty note, "not recoverable"
// values, empty states, and suspected-duplicate links into the Signals
// inbox.
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import ImportRunReport, {
  type DuplicateRow,
  type ErrorRow,
} from "./settings.imports.runs.$importRunId";

const RUN_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const SIGNAL_A = "0f9619ff-8b86-4d01-b42d-00cf4fc964aa";
const SIGNAL_B = "1f9619ff-8b86-4d01-b42d-00cf4fc964bb";

interface Overrides {
  status?: "running" | "completed" | "completed_with_errors" | "failed";
  stale?: boolean;
  filename?: string | null;
  finishedAtLabel?: string | null;
  counts?: Partial<{
    created: number;
    merged: number;
    skipped: number;
    failed: number;
    suspectedDuplicates: number;
  }>;
  errors?: Partial<{
    total: number;
    recorded: number;
    unrecorded: number;
    rows: ErrorRow[];
    headers: string[] | null;
    page: number;
    pageCount: number;
    sort: "asc" | "desc";
  }>;
  duplicates?: DuplicateRow[];
}

function errorRow(overrides: Partial<ErrorRow> = {}): ErrorRow {
  return {
    rowNumber: 12,
    reason: "The date column is empty.",
    values: ["", "Lovely visit", "5"],
    stage: "import",
    payloadRef: "row:12",
    ...overrides,
  };
}

function duplicateRow(): DuplicateRow {
  return {
    linkId: "2f9619ff-8b86-4d01-b42d-00cf4fc964cc",
    status: "pending_review",
    a: {
      signalId: SIGNAL_A,
      sourceLabel: "Google",
      visibilityLabel: "Public",
      occurredOn: "March 2, 2026",
      snippet: "Dr. Patel was wonderful with my daughter.",
      fromThisRun: false,
    },
    b: {
      signalId: SIGNAL_B,
      sourceLabel: "CSV import",
      visibilityLabel: "Private",
      occurredOn: "March 2, 2026",
      snippet: "Dr Patel was wonderful with my daughter!",
      fromThisRun: true,
    },
  };
}

function loaderData(overrides: Overrides = {}) {
  return {
    run: {
      id: RUN_ID,
      status: overrides.status ?? "completed",
      stale: overrides.stale ?? false,
      sourceLabel: "CSV import",
      filename:
        overrides.filename === undefined ? "reviews.csv" : overrides.filename,
      trigger: "manual" as const,
      startedAtLabel: "July 10, 2026, 12:00 PM UTC",
      finishedAtLabel:
        overrides.finishedAtLabel === undefined
          ? "July 10, 2026, 12:05 PM UTC"
          : overrides.finishedAtLabel,
      durationLabel: "5m",
      counts: {
        created: 120,
        merged: 3,
        skipped: 1,
        failed: 0,
        suspectedDuplicates: 0,
        ...overrides.counts,
      },
      totalProcessed: 124,
    },
    errors: {
      total: 0,
      recorded: 0,
      unrecorded: 0,
      rows: [],
      headers: null,
      page: 1,
      pageCount: 1,
      sort: "asc" as const,
      ...overrides.errors,
    },
    duplicates: overrides.duplicates ?? [],
    failuresCsvUrl: `http://localhost:8787/api/imports/runs/${RUN_ID}/failures.csv`,
  };
}

/** SSR splits adjacent text nodes with comment markers; strip them. */
function clean(html: string): string {
  return html.replaceAll("<!-- -->", "");
}

function render(data: ReturnType<typeof loaderData>, path?: string): string {
  const ReportAny = ImportRunReport as (props: {
    loaderData: unknown;
  }) => React.ReactNode;
  const Stub = createRoutesStub([
    {
      path: "/settings/imports/runs/:importRunId",
      Component: () => <ReportAny loaderData={data} />,
    },
  ]);
  return clean(
    renderToString(
      <Stub initialEntries={[path ?? `/settings/imports/runs/${RUN_ID}`]} />,
    ),
  );
}

describe("import report rendering", () => {
  it("completed: counts tiles, clean-error empty state, no-duplicates state", () => {
    const html = render(loaderData());
    expect(html).toContain("reviews.csv");
    expect(html).toContain('data-status="completed"');
    expect(html.match(/data-testid="stat-tile"/g)).toHaveLength(5);
    expect(html).toContain('data-testid="errors-empty"');
    expect(html).toContain("Every row imported cleanly");
    expect(html).toContain('data-testid="duplicates-empty"');
    // No failures CSV link when there is nothing to download.
    expect(html).not.toContain('data-testid="failures-csv-link"');
  });

  it("running: live-progress copy and no finished timestamp", () => {
    const html = render(
      loaderData({ status: "running", finishedAtLabel: null }),
    );
    expect(html).toContain("Import in progress");
    expect(html).toContain("This page updates automatically");
    expect(html).toContain("Still running");
  });

  it("stale running: taking-longer-than-expected with a support hint", () => {
    const html = render(
      loaderData({ status: "running", stale: true, finishedAtLabel: null }),
    );
    expect(html).toContain("Taking longer than expected");
    expect(html).toContain("contact support");
    expect(html).not.toContain("This page updates automatically");
  });

  it("failed and completed_with_errors carry their badges", () => {
    expect(render(loaderData({ status: "failed" }))).toContain(
      'data-status="failed"',
    );
    expect(render(loaderData({ status: "completed_with_errors" }))).toContain(
      'data-status="completed_with_errors"',
    );
  });

  it("falls back to the source label when the run has no draft filename", () => {
    const html = render(loaderData({ filename: null }));
    expect(html).not.toContain("reviews.csv");
    expect(html).toContain("CSV import import");
  });

  it("error table: rows with number, reason, original values, and the CSV link", () => {
    const html = render(
      loaderData({
        counts: { failed: 2 },
        errors: {
          total: 2,
          recorded: 2,
          rows: [
            errorRow(),
            errorRow({
              rowNumber: 40,
              reason: "The rating isn't a number.",
              values: ["2026-01-02", "Great", "five stars"],
              payloadRef: "row:40",
            }),
          ],
          headers: ["Date", "Review", "Rating"],
        },
      }),
    );
    expect(html.match(/data-testid="error-row"/g)).toHaveLength(2);
    expect(html).toContain("The date column is empty.");
    expect(html).toContain("five stars");
    expect(html).toContain('data-testid="failures-csv-link"');
    expect(html).toContain(`/api/imports/runs/${RUN_ID}/failures.csv`);
    // Single page: no pagination chrome.
    expect(html).not.toContain('data-testid="errors-pagination"');
  });

  it("stage-level failures render without a row number, values marked not recoverable", () => {
    const html = render(
      loaderData({
        counts: { failed: 1 },
        errors: {
          total: 1,
          recorded: 1,
          rows: [
            errorRow({
              rowNumber: null,
              reason: "Raw artifact not found",
              values: null,
              stage: "ingest",
              payloadRef: "p/manual/deadbeef.json",
            }),
          ],
        },
      }),
    );
    expect(html).toContain("Not recoverable");
    expect(html).toContain("[ingest]");
    expect(html).toContain("p/manual/deadbeef.json");
  });

  it("paginates the error table and links the sort toggle", () => {
    const html = render(
      loaderData({
        counts: { failed: 60 },
        errors: {
          total: 60,
          recorded: 60,
          rows: Array.from({ length: 20 }, (_, i) =>
            errorRow({ rowNumber: i + 21, payloadRef: `row:${i + 21}` }),
          ),
          headers: ["Date", "Review", "Rating"],
          page: 2,
          pageCount: 3,
        },
      }),
      `/settings/imports/runs/${RUN_ID}?errors_page=2`,
    );
    expect(html).toContain('data-testid="errors-pagination"');
    expect(html).toContain("Page 2 of 3");
    expect(html).toContain("errors_page=1");
    expect(html).toContain("errors_page=3");
    expect(html).toContain('data-testid="errors-sort"');
    expect(html).toContain("errors_sort=desc");
  });

  it("states the cap honestly when failures outnumber recorded samples", () => {
    const html = render(
      loaderData({
        counts: { failed: 137 },
        errors: {
          total: 137,
          recorded: 100,
          unrecorded: 37,
          rows: [errorRow()],
          headers: ["Date", "Review", "Rating"],
        },
      }),
    );
    expect(html).toContain('data-testid="errors-cap-note"');
    expect(html).toContain("37 additional failed");
    expect(html).toContain("not");
    expect(html).toContain("individually recorded");
  });

  it("suspected duplicates link both signals into the inbox", () => {
    const html = render(loaderData({ duplicates: [duplicateRow()] }));
    expect(html).toContain('data-testid="duplicate-row"');
    expect(html).toContain(`/signals/${SIGNAL_A}`);
    expect(html).toContain(`/signals/${SIGNAL_B}`);
    expect(html).toContain("this import");
    expect(html).toContain("Nothing was merged");
  });
});
