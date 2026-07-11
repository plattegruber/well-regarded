/**
 * `import_runs` helper coverage (issue #111): round-trips, transactional
 * count semantics (concurrent increments both land), the error-sample cap,
 * `finalizeImportRun` status derivation, and the practice-scoped reads —
 * all against a real Postgres via the template-clone harness.
 */

import { IMPORT_RUN_ERROR_SAMPLE_CAP } from "@wellregarded/core";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { importRun, practice } from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import { recordPipelineFailure } from "../pipeline.js";
import { importRuns } from "../schema/importRuns.js";
import {
  appendImportRunError,
  createImportRun,
  finalizeImportRun,
  getImportRunSummary,
  incrementImportRunCounts,
  listImportRuns,
} from "./importRuns.js";

const t = setupTestDb();

function sample(n: number) {
  return {
    stage: "ingest",
    message: `boom ${n}`,
    payloadRef: `raw/key-${n}.json`,
    occurredAt: "2026-07-10T12:00:00.000Z",
  };
}

describe("createImportRun / round-trip", () => {
  it("opens a running row with zeroed counts and stored artifact keys", async () => {
    const p = await practice(t.db);
    const run = await createImportRun(t.db, {
      practiceId: p.id,
      sourceKind: "google",
      trigger: "cron",
      rawArtifactKeys: ["a/b/c.json"],
    });
    expect(run.status).toBe("running");
    expect(run.finishedAt).toBeNull();
    expect([run.created, run.merged, run.skipped, run.failed]).toEqual([
      0, 0, 0, 0,
    ]);
    expect(run.rawArtifactKeys).toEqual(["a/b/c.json"]);
    expect(run.errorSamples).toEqual([]);
  });
});

describe("incrementImportRunCounts", () => {
  it("adds deltas and accumulates statsPatch keys", async () => {
    const run = await importRun(t.db);
    await incrementImportRunCounts(
      t.db,
      run.id,
      { created: 3, skipped: 1 },
      { suspected_duplicates: 2 },
    );
    await incrementImportRunCounts(
      t.db,
      run.id,
      { merged: 2, failed: 1 },
      { suspected_duplicates: 1, routed_recovery: 4 },
    );
    const [row] = await t.db
      .select()
      .from(importRuns)
      .where(eq(importRuns.id, run.id));
    expect(row).toMatchObject({ created: 3, merged: 2, skipped: 1, failed: 1 });
    expect(row?.stats).toEqual({ suspected_duplicates: 3, routed_recovery: 4 });
  });

  it("takes the caller's transaction and commits atomically with it", async () => {
    const run = await importRun(t.db);
    await expect(
      t.db.transaction(async (tx) => {
        await incrementImportRunCounts(tx, run.id, { created: 5 });
        throw new Error("roll it back");
      }),
    ).rejects.toThrow("roll it back");
    const [after] = await t.db
      .select()
      .from(importRuns)
      .where(eq(importRuns.id, run.id));
    expect(after?.created).toBe(0);
  });

  it("concurrent increments from two transactions both land (no lost updates)", async () => {
    const run = await importRun(t.db);
    // Two overlapping transactions; SET x = x + $n serializes on the row
    // lock, so both deltas survive — the entire concurrency story (#111).
    await Promise.all([
      t.db.transaction(async (tx) => {
        await incrementImportRunCounts(tx, run.id, { created: 1 });
      }),
      t.db.transaction(async (tx) => {
        await incrementImportRunCounts(tx, run.id, { created: 1 });
        await incrementImportRunCounts(tx, run.id, { failed: 1 });
      }),
    ]);
    const [row] = await t.db
      .select()
      .from(importRuns)
      .where(eq(importRuns.id, run.id));
    expect(row?.created).toBe(2);
    expect(row?.failed).toBe(1);
  });
});

describe("appendImportRunError", () => {
  it("caps error_samples while `failed` keeps counting", async () => {
    const run = await importRun(t.db);
    const total = IMPORT_RUN_ERROR_SAMPLE_CAP + 7;
    for (let i = 0; i < total; i++) {
      await appendImportRunError(t.db, run.id, sample(i));
    }
    const [row] = await t.db
      .select()
      .from(importRuns)
      .where(eq(importRuns.id, run.id));
    expect(row?.failed).toBe(total);
    expect(row?.errorSamples).toHaveLength(IMPORT_RUN_ERROR_SAMPLE_CAP);
    expect(row?.errorSamples[0]).toEqual(sample(0));
  });
});

describe("finalizeImportRun", () => {
  it("derives `completed` when nothing failed", async () => {
    const run = await importRun(t.db);
    await incrementImportRunCounts(t.db, run.id, { created: 2 });
    const finalized = await finalizeImportRun(t.db, run.id);
    expect(finalized?.status).toBe("completed");
    expect(finalized?.finishedAt).not.toBeNull();
  });

  it("derives `completed_with_errors` when successes and failures mix", async () => {
    const run = await importRun(t.db);
    await incrementImportRunCounts(t.db, run.id, { created: 1, failed: 2 });
    const finalized = await finalizeImportRun(t.db, run.id);
    expect(finalized?.status).toBe("completed_with_errors");
  });

  it("derives `failed` on failures with zero successes", async () => {
    const run = await importRun(t.db);
    await incrementImportRunCounts(t.db, run.id, { failed: 3 });
    const finalized = await finalizeImportRun(t.db, run.id);
    expect(finalized?.status).toBe("failed");
  });

  it("treats an empty run (no work, no failures) as completed", async () => {
    const run = await importRun(t.db);
    const finalized = await finalizeImportRun(t.db, run.id);
    expect(finalized?.status).toBe("completed");
  });
});

describe("getImportRunSummary", () => {
  it("returns the run with derived fields in one round trip", async () => {
    const run = await importRun(t.db);
    await incrementImportRunCounts(t.db, run.id, { created: 4, skipped: 1 });
    await appendImportRunError(t.db, run.id, sample(1));
    await finalizeImportRun(t.db, run.id);

    const summary = await getImportRunSummary(t.db, run.practiceId, run.id);
    expect(summary).toBeDefined();
    expect(summary?.totalProcessed).toBe(6);
    expect(summary?.errorCount).toBe(1);
    expect(summary?.errorSamples).toEqual([sample(1)]);
    expect(summary?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("is practice-scoped: another practice's id sees nothing", async () => {
    const run = await importRun(t.db);
    const other = await practice(t.db);
    expect(await getImportRunSummary(t.db, other.id, run.id)).toBeUndefined();
  });

  it("limits the returned samples without touching errorCount", async () => {
    const run = await importRun(t.db);
    for (let i = 0; i < 5; i++) {
      await appendImportRunError(t.db, run.id, sample(i));
    }
    const summary = await getImportRunSummary(t.db, run.practiceId, run.id, {
      errorSampleLimit: 2,
    });
    expect(summary?.errorSamples).toHaveLength(2);
    expect(summary?.errorCount).toBe(5);
  });
});

describe("listImportRuns", () => {
  it("lists newest-first, filters by sourceKind, and paginates by cursor", async () => {
    const p = await practice(t.db);
    const runs = [];
    for (let i = 0; i < 5; i++) {
      runs.push(
        await importRun(t.db, {
          practiceId: p.id,
          sourceKind: i % 2 === 0 ? "csv_import" : "google",
          startedAt: new Date(Date.UTC(2026, 6, 1 + i)),
        }),
      );
    }
    // Another practice's runs never leak in.
    await importRun(t.db);

    const pageOne = await listImportRuns(t.db, p.id, { limit: 3 });
    expect(pageOne.runs.map((r) => r.id)).toEqual(
      [runs[4], runs[3], runs[2]].map((r) => r?.id),
    );
    expect(pageOne.nextCursor).toBeDefined();

    const pageTwo = await listImportRuns(t.db, p.id, {
      limit: 3,
      cursor: pageOne.nextCursor,
    });
    expect(pageTwo.runs.map((r) => r.id)).toEqual(
      [runs[1], runs[0]].map((r) => r?.id),
    );
    expect(pageTwo.nextCursor).toBeUndefined();

    const googleOnly = await listImportRuns(t.db, p.id, {
      sourceKind: "google",
    });
    expect(googleOnly.runs).toHaveLength(2);
  });
});

describe("recordPipelineFailure (import_runs persistence)", () => {
  it("appends the failure to the run the body names, visible in the summary", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = await importRun(t.db);
    await recordPipelineFailure(t.db, {
      stage: "ingest",
      reason: "non_retryable",
      errorMessage: "artifact missing",
      body: {
        importRunId: run.id,
        rawArtifactKey: "p/google/dead.json",
        sourceKind: "google",
        practiceId: run.practiceId,
      },
      occurredAt: new Date("2026-07-10T12:00:00Z"),
    });
    const summary = await getImportRunSummary(t.db, run.practiceId, run.id);
    expect(summary?.errorCount).toBe(1);
    expect(summary?.errorSamples[0]).toMatchObject({
      stage: "ingest",
      message: "artifact missing",
      payloadRef: "p/google/dead.json",
    });
    vi.restoreAllMocks();
  });
});
