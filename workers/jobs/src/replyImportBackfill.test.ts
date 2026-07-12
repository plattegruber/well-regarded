/**
 * Unit tests for the reply-import backfill orchestration loop (issue
 * #214): fake step, fake batches, no Postgres, no R2. The per-batch DB/R2
 * work is covered by test/replyImportBackfill.integration.test.ts.
 */

import { describe, expect, it } from "vitest";

import { FakeWorkflowStep } from "../test/support/fakeStep";
import {
  DEFAULT_REPLY_IMPORT_BATCH_SIZE,
  DEFAULT_REPLY_IMPORT_SLEEP_MS,
  type ReplyImportBatchResult,
  type ReplyImportCounts,
  resolveReplyImportParams,
  runReplyImportBackfill,
} from "./replyImportBackfill";

function counts(overrides: Partial<ReplyImportCounts> = {}): ReplyImportCounts {
  return {
    scanned: 0,
    withReply: 0,
    imported: 0,
    updated: 0,
    unchanged: 0,
    artifactsMissing: 0,
    artifactsFailed: 0,
    ...overrides,
  };
}

function batches(results: ReplyImportBatchResult[]): {
  processBatch: (afterId: string | null) => Promise<ReplyImportBatchResult>;
  calls: (string | null)[];
} {
  const calls: (string | null)[] = [];
  return {
    calls,
    processBatch: async (afterId) => {
      calls.push(afterId);
      const result = results[calls.length - 1];
      if (!result) throw new Error("unexpected extra batch");
      return result;
    },
  };
}

describe("resolveReplyImportParams", () => {
  it("applies documented defaults to a missing payload", () => {
    expect(resolveReplyImportParams(undefined)).toEqual({
      practiceId: undefined,
      batchSize: DEFAULT_REPLY_IMPORT_BATCH_SIZE,
      sleepMs: DEFAULT_REPLY_IMPORT_SLEEP_MS,
    });
    expect(DEFAULT_REPLY_IMPORT_BATCH_SIZE).toBe(100);
    expect(DEFAULT_REPLY_IMPORT_SLEEP_MS).toBe(1000);
  });

  it("honors overrides, including a practice scope", () => {
    expect(
      resolveReplyImportParams({
        practiceId: "p-1",
        batchSize: 5,
        sleepMs: 10,
      }),
    ).toEqual({ practiceId: "p-1", batchSize: 5, sleepMs: 10 });
  });
});

describe("runReplyImportBackfill", () => {
  const params = { practiceId: undefined, batchSize: 2, sleepMs: 250 };

  it("threads the keyset cursor through batches, sleeps between them, and totals every counter", async () => {
    const step = new FakeWorkflowStep();
    const fake = batches([
      {
        ...counts({ scanned: 2, withReply: 1, imported: 1 }),
        lastId: "id-2",
        done: false,
      },
      {
        ...counts({ scanned: 2, withReply: 2, updated: 1, unchanged: 1 }),
        lastId: "id-4",
        done: false,
      },
      {
        ...counts({ scanned: 1, artifactsMissing: 1 }),
        lastId: "id-5",
        done: true,
      },
    ]);

    const summary = await runReplyImportBackfill(step, fake, params);

    expect(summary).toEqual({
      batches: 3,
      scanned: 5,
      withReply: 3,
      imported: 1,
      updated: 1,
      unchanged: 1,
      artifactsMissing: 1,
      artifactsFailed: 0,
    });
    expect(fake.calls).toEqual([null, "id-2", "id-4"]);
    // One durable checkpoint per batch, a pause after each non-final batch.
    expect(step.executed).toEqual([
      "import-replies-batch-0",
      "import-replies-batch-1",
      "import-replies-batch-2",
    ]);
    expect(step.sleeps).toEqual([
      ["pause-after-batch-0", 250],
      ["pause-after-batch-1", 250],
    ]);
  });

  it("finishes immediately (no sleep) when there is nothing to scan", async () => {
    const step = new FakeWorkflowStep();
    const fake = batches([{ ...counts(), lastId: null, done: true }]);

    const summary = await runReplyImportBackfill(step, fake, params);

    expect(summary).toEqual({ batches: 0, ...counts() });
    expect(step.sleeps).toEqual([]);
  });

  it("resumes after a failed batch without re-running completed batches", async () => {
    const step = new FakeWorkflowStep();
    let failNext = true;
    const executedBatches: (string | null)[] = [];
    const deps = {
      processBatch: async (afterId: string | null) => {
        executedBatches.push(afterId);
        if (afterId === "id-2" && failNext) {
          failNext = false;
          throw new Error("Postgres connection reset");
        }
        return afterId === null
          ? {
              ...counts({ scanned: 2, withReply: 1, imported: 1 }),
              lastId: "id-2",
              done: false,
            }
          : {
              ...counts({ scanned: 1, withReply: 1, imported: 1 }),
              lastId: "id-3",
              done: true,
            };
      },
    };

    // First run: batch 0 checkpoints, batch 1 throws — the instance fails.
    await expect(runReplyImportBackfill(step, deps, params)).rejects.toThrow(
      "connection reset",
    );

    // Retry against the same durable state (same FakeWorkflowStep): batch 0
    // replays from the checkpoint (its callback does NOT run again), batch 1
    // re-executes and completes.
    const summary = await runReplyImportBackfill(step, deps, params);

    expect(summary).toEqual({
      batches: 2,
      ...counts({ scanned: 3, withReply: 2, imported: 2 }),
    });
    // The first batch's work ran exactly once across both attempts.
    expect(executedBatches).toEqual([null, "id-2", "id-2"]);
  });
});
