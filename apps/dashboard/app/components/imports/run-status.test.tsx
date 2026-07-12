// Status presentation shared by the imports list and the report (#137):
// tone mapping per status, and the staleness threshold that turns an
// eternal "Running" into an honest "taking longer than expected".
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  IMPORT_RUN_STALE_AFTER_MS,
  isImportRunStale,
  RunStatusBadge,
} from "./run-status";

describe("RunStatusBadge", () => {
  it("labels every status with its tone", () => {
    expect(renderToString(<RunStatusBadge status="running" />)).toContain(
      "Running",
    );
    const completed = renderToString(<RunStatusBadge status="completed" />);
    expect(completed).toContain("Completed");
    expect(completed).toContain("status-positive");
    const withErrors = renderToString(
      <RunStatusBadge status="completed_with_errors" />,
    );
    expect(withErrors).toContain("Completed with errors");
    expect(withErrors).toContain("status-caution");
    const failed = renderToString(<RunStatusBadge status="failed" />);
    expect(failed).toContain("Failed");
    expect(failed).toContain("status-negative");
  });

  it("renders the stale variant for a long-running run", () => {
    const html = renderToString(<RunStatusBadge status="running" stale />);
    expect(html).toContain("Taking longer than expected");
    expect(html).toContain('data-status="stale"');
  });

  it("stale never applies to terminal statuses", () => {
    const html = renderToString(<RunStatusBadge status="failed" stale />);
    expect(html).toContain("Failed");
    expect(html).not.toContain("Taking longer");
  });
});

describe("isImportRunStale", () => {
  const now = new Date("2026-07-10T12:00:00Z");

  it("flags only running runs older than the threshold", () => {
    const old = new Date(now.getTime() - IMPORT_RUN_STALE_AFTER_MS - 1);
    const recent = new Date(now.getTime() - 60_000);
    expect(isImportRunStale("running", old, now)).toBe(true);
    expect(isImportRunStale("running", recent, now)).toBe(false);
    expect(isImportRunStale("failed", old, now)).toBe(false);
    expect(isImportRunStale("completed", old, now)).toBe(false);
  });
});
