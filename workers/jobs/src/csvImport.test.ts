/**
 * Unit tests for the CSV import orchestration (issue #135): fake step,
 * fake deps, no Postgres, no R2. Covers the deterministic step layout,
 * the drain loop (polls, pauses, `>=` completion, the 2h cap), the
 * failure finalization (a run never stays `running`), and — the reason
 * it is a Workflow at all — resume against memoized checkpoints without
 * re-running completed work. The real per-step work is covered by
 * test/csvImport.integration.test.ts.
 */

import { describe, expect, it, vi } from "vitest";

import { FakeWorkflowStep } from "../test/support/fakeStep";
import {
  type CsvChunkResult,
  type CsvImportDeps,
  type CsvImportParams,
  DRAIN_POLL_INTERVAL_MS,
  MAX_DRAIN_POLLS,
  resolveCsvImportParams,
  runCsvImport,
} from "./csvImport";

const params: CsvImportParams = {
  importDraftId: "3b74b0f7-6d7c-4b7e-9f36-1af6a29f2f3a",
  practiceId: "0b54c7c1-32c8-4b02-a24f-8f1a9df6f9f7",
  requestId: "req-test-1",
};

const IMPORT_RUN_ID = "9e0f95b1-79b4-4dd1-8fd2-24c05d64f2ea";

function chunkResult(overrides: Partial<CsvChunkResult> = {}): CsvChunkResult {
  return {
    batchKeys: ["p/csv_import/aaa.json", "p/csv_import/bbb.json"],
    totalRows: 150,
    failedRows: 3,
    errorSamples: [],
    ...overrides,
  };
}

/**
 * Recording fake deps: every method is a `vi.fn` with a sensible happy
 * path; tests override behaviors per case.
 */
function fakeDeps(overrides: Partial<CsvImportDeps> = {}) {
  const deps: CsvImportDeps = {
    validate: vi.fn().mockResolvedValue({
      importRunId: IMPORT_RUN_ID,
      r2Key: "p/imports/deadbeef.csv",
      headers: ["Date", "Review"],
      mapping: {
        occurredAt: { column: "Date", dateFormat: "ISO" },
        text: { column: "Review" },
      },
      requestId: "req-test-1",
    }),
    chunk: vi.fn().mockResolvedValue(chunkResult()),
    recordChunk: vi.fn().mockResolvedValue(undefined),
    enqueueBatches: vi.fn().mockResolvedValue(2),
    pollProcessedCount: vi.fn().mockResolvedValue(150),
    recordDrainTimeout: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue({
      importRunId: IMPORT_RUN_ID,
      status: "completed",
      created: 147,
      merged: 0,
      skipped: 0,
      failed: 3,
      totalRows: 150,
      batches: 2,
      drained: true,
    }),
    recordWorkflowFailure: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return deps;
}

describe("resolveCsvImportParams", () => {
  it("accepts a valid payload and rejects garbage non-retryably", () => {
    expect(resolveCsvImportParams(params)).toEqual(params);
    for (const bad of [
      undefined,
      {},
      { importDraftId: "not-a-uuid", practiceId: params.practiceId },
      { importDraftId: params.importDraftId },
    ]) {
      expect(() => resolveCsvImportParams(bad)).toThrow(
        expect.objectContaining({ name: "NonRetryableError" }),
      );
    }
  });
});

describe("runCsvImport — step layout", () => {
  it("runs validate → chunk → record → enqueue → drain → finalize with deterministic names", async () => {
    const step = new FakeWorkflowStep();
    // Two polls to drain: 60 first, then past totalRows.
    const deps = fakeDeps({
      pollProcessedCount: vi
        .fn()
        .mockResolvedValueOnce(60)
        .mockResolvedValueOnce(150),
    });

    const summary = await runCsvImport(step, deps, params);

    expect(summary.status).toBe("completed");
    expect(step.executed).toEqual([
      "validate",
      "chunk",
      "record-chunk",
      "enqueue-batches",
      "poll-import-counts-0",
      "poll-import-counts-1",
      "finalize",
    ]);
    expect(step.sleeps).toEqual([["drain-pause-0", DRAIN_POLL_INTERVAL_MS]]);
    expect(deps.enqueueBatches).toHaveBeenCalledExactlyOnceWith(
      params,
      expect.objectContaining({ importRunId: IMPORT_RUN_ID }),
      ["p/csv_import/aaa.json", "p/csv_import/bbb.json"],
    );
    expect(deps.recordChunk).toHaveBeenCalledBefore(
      deps.enqueueBatches as ReturnType<typeof vi.fn>,
    );
    expect(deps.finalize).toHaveBeenCalledExactlyOnceWith(
      params,
      expect.anything(),
      expect.objectContaining({ totalRows: 150 }),
      true,
    );
    expect(deps.recordDrainTimeout).not.toHaveBeenCalled();
    expect(deps.recordWorkflowFailure).not.toHaveBeenCalled();
  });

  it("an empty file skips the drain loop entirely and still finalizes", async () => {
    const step = new FakeWorkflowStep();
    const deps = fakeDeps({
      chunk: vi
        .fn()
        .mockResolvedValue(
          chunkResult({ batchKeys: [], totalRows: 0, failedRows: 0 }),
        ),
    });

    await runCsvImport(step, deps, params);

    expect(deps.pollProcessedCount).not.toHaveBeenCalled();
    expect(step.sleeps).toEqual([]);
    expect(deps.finalize).toHaveBeenCalledExactlyOnceWith(
      params,
      expect.anything(),
      expect.objectContaining({ totalRows: 0 }),
      true,
    );
  });

  it("counts past totalRows (re-delivery inflation) still count as drained", async () => {
    const step = new FakeWorkflowStep();
    const deps = fakeDeps({
      pollProcessedCount: vi.fn().mockResolvedValue(153), // > 150
    });

    await runCsvImport(step, deps, params);

    expect(deps.finalize).toHaveBeenCalledWith(
      params,
      expect.anything(),
      expect.anything(),
      true,
    );
    expect(step.sleeps).toEqual([]);
  });
});

describe("runCsvImport — drain timeout (the 2h cap)", () => {
  it("records a drain-timeout note and finalizes as not-drained after MAX_DRAIN_POLLS", async () => {
    const step = new FakeWorkflowStep();
    const deps = fakeDeps({
      pollProcessedCount: vi.fn().mockResolvedValue(10), // never reaches 150
    });

    await runCsvImport(step, deps, params);

    // MAX_DRAIN_POLLS in-loop polls + the final count read for the note.
    expect(deps.pollProcessedCount).toHaveBeenCalledTimes(MAX_DRAIN_POLLS + 1);
    expect(step.sleeps).toHaveLength(MAX_DRAIN_POLLS);
    // 240 x 30s = the documented 2h wall-clock cap.
    expect(MAX_DRAIN_POLLS * DRAIN_POLL_INTERVAL_MS).toBe(2 * 60 * 60 * 1000);
    expect(deps.recordDrainTimeout).toHaveBeenCalledExactlyOnceWith(
      IMPORT_RUN_ID,
      { totalRows: 150, processed: 10 },
    );
    expect(deps.finalize).toHaveBeenCalledWith(
      params,
      expect.anything(),
      expect.anything(),
      false,
    );
  });
});

describe("runCsvImport — failure semantics (never leave a run running)", () => {
  it("a failure past validate finalizes the run via record-workflow-failure, then rethrows", async () => {
    const step = new FakeWorkflowStep();
    const deps = fakeDeps({
      chunk: vi.fn().mockRejectedValue(new Error("R2 exploded")),
    });

    await expect(runCsvImport(step, deps, params)).rejects.toThrow(
      "R2 exploded",
    );
    expect(deps.recordWorkflowFailure).toHaveBeenCalledExactlyOnceWith(
      params,
      IMPORT_RUN_ID,
      "R2 exploded",
    );
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it("a validate failure rethrows without failure-finalization — no run exists yet", async () => {
    const step = new FakeWorkflowStep();
    const deps = fakeDeps({
      validate: vi.fn().mockRejectedValue(new Error("draft not confirmed")),
    });

    await expect(runCsvImport(step, deps, params)).rejects.toThrow(
      "draft not confirmed",
    );
    expect(deps.recordWorkflowFailure).not.toHaveBeenCalled();
  });
});

describe("runCsvImport — resume against durable checkpoints", () => {
  it("a re-invoked instance replays completed steps from checkpoints: no duplicate runs, artifacts, or messages", async () => {
    const step = new FakeWorkflowStep();
    let enqueueAttempts = 0;
    const deps = fakeDeps({
      enqueueBatches: vi.fn().mockImplementation(async () => {
        enqueueAttempts += 1;
        if (enqueueAttempts === 1) throw new Error("isolate evicted");
        return 2;
      }),
      pollProcessedCount: vi.fn().mockResolvedValue(150),
    });

    // First attempt dies mid-enqueue (validate/chunk/record checkpointed).
    await expect(runCsvImport(step, deps, params)).rejects.toThrow(
      "isolate evicted",
    );

    // Replay against the same durable state: completed steps come from
    // the checkpoint cache — their callbacks do NOT re-run.
    const summary = await runCsvImport(step, deps, params);

    expect(summary.status).toBe("completed");
    expect(deps.validate).toHaveBeenCalledTimes(1); // ONE import run created
    expect(deps.chunk).toHaveBeenCalledTimes(1); // the file parsed ONCE
    expect(deps.recordChunk).toHaveBeenCalledTimes(1);
    expect(deps.enqueueBatches).toHaveBeenCalledTimes(2); // failed, then re-ran
    expect(deps.finalize).toHaveBeenCalledTimes(1);
    // The second run received the SAME checkpointed batch keys.
    expect(
      (deps.enqueueBatches as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => call[2],
      ),
    ).toEqual([
      ["p/csv_import/aaa.json", "p/csv_import/bbb.json"],
      ["p/csv_import/aaa.json", "p/csv_import/bbb.json"],
    ]);
  });
});
