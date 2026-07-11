import { afterEach, describe, expect, it, vi } from "vitest";

import type { Db } from "./client.js";
import { recordPipelineFailure } from "./pipeline.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A Db stub that records whether the import_runs UPDATE path was reached.
 * The real SQL is covered by pipeline.integration.test.ts; these unit tests
 * pin the routing rules (log always; write only with a resolvable run id).
 */
function dbStub() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  return { db: { update } as unknown as Db, update };
}

describe("recordPipelineFailure", () => {
  it("logs one structured line carrying the full failure record", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, update } = dbStub();
    await recordPipelineFailure(db, {
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
    // Body carries no importRunId — log-only, no import_runs write.
    expect(update).not.toHaveBeenCalled();
  });

  it("writes to the owning import run when the body names one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, update } = dbStub();
    await recordPipelineFailure(db, {
      stage: "ingest",
      reason: "non_retryable",
      errorMessage: "artifact missing",
      body: {
        importRunId: "8a9c1a52-6a54-4d43-9c39-9d5df2bb0e1a",
        rawArtifactKey: "p/google/abc.json",
      },
      occurredAt: new Date("2026-07-10T12:00:00Z"),
    });
    expect(update).toHaveBeenCalledOnce();
  });

  it("stays log-only when importRunId is not a uuid", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, update } = dbStub();
    await recordPipelineFailure(db, {
      stage: "ingest",
      reason: "malformed",
      errorMessage: "bad body",
      body: { importRunId: 42 },
      occurredAt: new Date("2026-07-10T12:00:00Z"),
    });
    expect(update).not.toHaveBeenCalled();
  });
});
