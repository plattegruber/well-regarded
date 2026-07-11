import { afterEach, describe, expect, it, vi } from "vitest";

import { recordPipelineFailure } from "./pipeline.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordPipelineFailure", () => {
  // Log-only until #111 lands the import_runs writer; the contract worth
  // pinning now is that every field of the failure is visible in the log
  // line, so nothing is silent even before it is queryable.
  it("logs one structured line carrying the full failure record", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await recordPipelineFailure({
      stage: "dedupe",
      reason: "malformed",
      errorMessage: "signalId missing",
      body: { broken: true },
      occurredAt: new Date("2026-07-10T12:00:00Z"),
    });
    expect(errorSpy).toHaveBeenCalledOnce();
    const line = String(errorSpy.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      event: "pipeline.failure",
      stage: "dedupe",
      reason: "malformed",
      errorMessage: "signalId missing",
      body: { broken: true },
      occurredAt: "2026-07-10T12:00:00.000Z",
    });
  });
});
