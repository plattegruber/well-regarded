// Rendering tests for the imports list (#137): the empty state, the row
// grid with running/failed indicators, the report links, and pagination.
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import Imports, { type ImportRunRow } from "./settings.imports";

function row(overrides: Partial<ImportRunRow> = {}): ImportRunRow {
  return {
    id: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    startedAgo: "3d ago",
    sourceLabel: "CSV import",
    triggerLabel: "Manual",
    status: "completed",
    stale: false,
    countsSummary: "120 created · 3 merged · 1 skipped",
    failed: 0,
    ...overrides,
  };
}

interface Overrides {
  rows?: ImportRunRow[];
  nextCursor?: string | null;
  paginated?: boolean;
  anyRunning?: boolean;
}

function loaderData(overrides: Overrides = {}) {
  return {
    rows: overrides.rows ?? [],
    nextCursor: overrides.nextCursor ?? null,
    paginated: overrides.paginated ?? false,
    anyRunning: overrides.anyRunning ?? false,
  };
}

function render(data: ReturnType<typeof loaderData>): string {
  const ImportsAny = Imports as (props: {
    loaderData: unknown;
  }) => React.ReactNode;
  const Stub = createRoutesStub([
    {
      path: "/settings/imports",
      Component: () => <ImportsAny loaderData={data} />,
    },
  ]);
  return renderToString(<Stub initialEntries={["/settings/imports"]} />);
}

describe("imports list rendering", () => {
  it("renders the empty state with the New import entry point", () => {
    const html = render(loaderData());
    expect(html).toContain('data-testid="imports-empty"');
    expect(html).toContain("Nothing imported yet");
    expect(html).toContain('href="/settings/imports/new"');
  });

  it("renders rows linking to the report page with counts and status", () => {
    const html = render(loaderData({ rows: [row()] }));
    expect(html).toContain('data-testid="import-run-row"');
    expect(html).toContain(
      "/settings/imports/runs/6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    );
    expect(html).toContain("120 created · 3 merged · 1 skipped");
    expect(html).toContain('data-status="completed"');
  });

  it("flags running, stale, and failed runs distinctly", () => {
    const html = render(
      loaderData({
        rows: [
          row({
            id: "aa9619ff-8b86-4d01-b42d-00cf4fc964ff",
            status: "running",
          }),
          row({
            id: "bb9619ff-8b86-4d01-b42d-00cf4fc964ff",
            status: "running",
            stale: true,
          }),
          row({
            id: "cc9619ff-8b86-4d01-b42d-00cf4fc964ff",
            status: "failed",
            countsSummary: "0 created · 0 merged · 0 skipped · 37 failed",
            failed: 37,
          }),
        ],
        anyRunning: true,
      }),
    );
    expect(html).toContain('data-status="running"');
    expect(html).toContain('data-status="stale"');
    expect(html).toContain('data-status="failed"');
    expect(html).toContain("37 failed");
  });

  it("paginates with cursor links", () => {
    const html = render(
      loaderData({ rows: [row()], nextCursor: "123:abc", paginated: true }),
    );
    expect(html).toContain("Older imports");
    expect(html).toContain("cursor=123%3Aabc");
    expect(html).toContain("Back to latest");
  });
});
