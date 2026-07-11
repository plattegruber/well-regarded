/**
 * Unit tests for the backfill orchestration loop (issue #71): fake step,
 * fake batches, no Postgres, no Workers AI. The per-batch DB work is
 * covered by test/embeddingBackfill.integration.test.ts.
 */

import { describe, expect, it } from "vitest";

import { FakeWorkflowStep } from "../test/support/fakeStep";
import {
  type BackfillBatchResult,
  DEFAULT_BACKFILL_BATCH_SIZE,
  DEFAULT_BACKFILL_SLEEP_MS,
  resolveBackfillParams,
  runEmbeddingBackfill,
} from "./embeddingBackfill";

function batches(results: BackfillBatchResult[]): {
  processBatch: (afterId: string | null) => Promise<BackfillBatchResult>;
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

describe("resolveBackfillParams", () => {
  it("applies documented defaults to a missing payload", () => {
    expect(resolveBackfillParams(undefined)).toEqual({
      practiceId: undefined,
      batchSize: DEFAULT_BACKFILL_BATCH_SIZE,
      sleepMs: DEFAULT_BACKFILL_SLEEP_MS,
    });
    expect(DEFAULT_BACKFILL_BATCH_SIZE).toBe(50);
    expect(DEFAULT_BACKFILL_SLEEP_MS).toBe(2000);
  });

  it("honors overrides, including a practice scope", () => {
    expect(
      resolveBackfillParams({ practiceId: "p-1", batchSize: 5, sleepMs: 10 }),
    ).toEqual({ practiceId: "p-1", batchSize: 5, sleepMs: 10 });
  });
});

describe("runEmbeddingBackfill", () => {
  const params = { practiceId: undefined, batchSize: 2, sleepMs: 250 };

  it("threads the keyset cursor through batches and sleeps between them (rate-aware)", async () => {
    const step = new FakeWorkflowStep();
    const fake = batches([
      { processed: 2, lastId: "id-2", done: false },
      { processed: 2, lastId: "id-4", done: false },
      { processed: 1, lastId: "id-5", done: true },
    ]);

    const summary = await runEmbeddingBackfill(step, fake, params);

    expect(summary).toEqual({ batches: 3, embedded: 5 });
    expect(fake.calls).toEqual([null, "id-2", "id-4"]);
    // One durable checkpoint per batch, a pause after each non-final batch.
    expect(step.executed).toEqual([
      "embed-batch-0",
      "embed-batch-1",
      "embed-batch-2",
    ]);
    expect(step.sleeps).toEqual([
      ["pause-after-batch-0", 250],
      ["pause-after-batch-1", 250],
    ]);
  });

  it("finishes immediately (no sleep) when nothing needs embedding", async () => {
    const step = new FakeWorkflowStep();
    const fake = batches([{ processed: 0, lastId: null, done: true }]);

    const summary = await runEmbeddingBackfill(step, fake, params);

    expect(summary).toEqual({ batches: 0, embedded: 0 });
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
          throw new Error("Workers AI rate limited");
        }
        return afterId === null
          ? { processed: 2, lastId: "id-2", done: false }
          : { processed: 1, lastId: "id-3", done: true };
      },
    };

    // First run: batch 0 checkpoints, batch 1 throws — the instance fails.
    await expect(runEmbeddingBackfill(step, deps, params)).rejects.toThrow(
      "rate limited",
    );

    // Retry against the same durable state (same FakeWorkflowStep): batch 0
    // replays from the checkpoint (its callback does NOT run again), batch 1
    // re-executes and completes.
    const summary = await runEmbeddingBackfill(step, deps, params);

    expect(summary).toEqual({ batches: 2, embedded: 3 });
    // The first batch's work ran exactly once across both attempts.
    expect(executedBatches).toEqual([null, "id-2", "id-2"]);
  });
});
