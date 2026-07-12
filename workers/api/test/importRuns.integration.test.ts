/**
 * Import-run report endpoints (issue #137): the runs listing (scoping) and
 * the failures-CSV download — content, header row, raw values
 * reconstructed from the run's batch artifacts, the honesty note past the
 * error-sample cap, and the permission re-check.
 */

import { IMPORT_RUN_ERROR_SAMPLE_CAP, resetEnvCache } from "@wellregarded/core";
import { appendImportRunError } from "@wellregarded/db";
import {
  buildCsvImportBatchArtifact,
  CSV_IMPORT_BATCH_SIZE,
  putRawArtifact,
} from "@wellregarded/sources";
import { InMemoryRawArtifactBucket } from "@wellregarded/sources/testing";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  importRun,
  practice,
  staffMember,
} from "../../../packages/db/test/factories.js";
import { setupTestDb } from "../../../packages/db/test/harness.js";
import {
  requireDatabaseUrl,
  withDatabase,
} from "../../../packages/db/test/support.js";
import { app } from "../src/app";
import { testEnv } from "./support/env";
import {
  generateTestKeys,
  signSessionToken,
  type TestKeys,
} from "./support/jwt";

const t = setupTestDb();

let keys: TestKeys;

beforeAll(async () => {
  keys = await generateTestKeys();
});

beforeEach(() => {
  resetEnvCache();
});

function env(bucket: InMemoryRawArtifactBucket) {
  return testEnv({
    HYPERDRIVE: {
      connectionString: withDatabase(requireDatabaseUrl(), t.databaseName),
    },
    CLERK_JWKS_PUBLIC_KEY: keys.publicKeyPem,
    RAW_ARTIFACTS: bucket,
  });
}

async function staffCaller(role: "owner" | "front_desk" = "owner") {
  const n = `${role}_${Math.random().toString(36).slice(2, 10)}`;
  const p = await practice(t.db);
  const staff = await staffMember(t.db, {
    practiceId: p.id,
    clerkUserId: `user_${n}`,
    role,
  });
  const token = await signSessionToken(keys, {
    sub: staff.clerkUserId,
    claims: { o: { id: p.clerkOrgId, rol: "member" } },
  });
  return { practice: p, staff, token };
}

function get(path: string, token: string, e: object) {
  return app.request(
    `http://localhost${path}`,
    { headers: { Authorization: `Bearer ${token}` } },
    e,
  );
}

const DRAFT_ID = "3b74b0f7-6d7c-4b7e-9f36-1af6a29f2f3a";

/** Store a one-batch artifact holding the given rows, returning its key. */
async function storeBatch(
  bucket: InMemoryRawArtifactBucket,
  practiceId: string,
  rows: string[][],
) {
  const { key } = await putRawArtifact(bucket, {
    practiceId,
    sourceKind: "csv_import",
    content: JSON.stringify(
      buildCsvImportBatchArtifact({
        practiceId,
        draftId: DRAFT_ID,
        batchIndex: 0,
        firstRowNumber: 1,
        headers: ["Date", "Review, or note"],
        mapping: {
          occurredAt: { column: "Date", dateFormat: "ISO" },
          text: { column: "Review, or note" },
        },
        rows,
      }),
    ),
  });
  return key;
}

function rowSample(rowNumber: number, reason: string) {
  return {
    stage: "import",
    message: `Row ${rowNumber}: ${reason}`,
    payloadRef: `row:${rowNumber}`,
    occurredAt: "2026-07-10T12:00:00.000Z",
  };
}

describe("GET /api/imports/runs (issue #137)", () => {
  it("lists only the caller's practice's runs, newest first", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const caller = await staffCaller("owner");
    const mine = await importRun(t.db, { practiceId: caller.practice.id });
    await importRun(t.db); // another practice's run

    const response = await get("/api/imports/runs", caller.token, env(bucket));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { runs: Array<{ id: string }> };
    expect(body.runs.map((run) => run.id)).toEqual([mine.id]);
  });

  it("is permission-gated (front_desk lacks manage_settings)", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const caller = await staffCaller("front_desk");
    const response = await get("/api/imports/runs", caller.token, env(bucket));
    expect(response.status).toBe(403);
  });
});

describe("GET /api/imports/runs/:id/failures.csv (issue #137)", () => {
  it("streams row failures with original values from the batch artifacts, RFC 4180-escaped", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const caller = await staffCaller("owner");
    const key = await storeBatch(bucket, caller.practice.id, [
      ["2026-04-01", "fine row"],
      ["not-a-date", 'said "thanks", twice'],
      ["", "missing the date entirely"],
    ]);
    const run = await importRun(t.db, {
      practiceId: caller.practice.id,
      rawArtifactKeys: [key],
    });
    // Out of order on purpose — the CSV sorts by row number.
    await appendImportRunError(t.db, run.id, rowSample(3, "Date is empty."));
    await appendImportRunError(
      t.db,
      run.id,
      rowSample(2, "Date isn't a date."),
    );
    // A stage-level failure with no row number rides along, values blank.
    await appendImportRunError(t.db, run.id, {
      stage: "ingest",
      message: "Raw artifact not found",
      payloadRef: `${caller.practice.id}/csv_import/missing.json`,
      occurredAt: "2026-07-10T12:00:00.000Z",
    });

    const response = await get(
      `/api/imports/runs/${run.id}/failures.csv`,
      caller.token,
      env(bucket),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain(
      "failures.csv",
    );

    const lines = (await response.text()).trimEnd().split("\r\n");
    // Header row: row_number, reason, then the file's original columns
    // (the second one needs quoting — it contains a comma).
    expect(lines[0]).toBe('row_number,reason,Date,"Review, or note"');
    expect(lines[1]).toBe(
      '2,Date isn\'t a date.,not-a-date,"said ""thanks"", twice"',
    );
    expect(lines[2]).toBe("3,Date is empty.,,missing the date entirely");
    expect(lines[3]).toContain("[ingest] Raw artifact not found");
    expect(lines).toHaveLength(4);
  });

  it("appends the honesty note when failures exceed the recorded samples", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const caller = await staffCaller("owner");
    const run = await importRun(t.db, { practiceId: caller.practice.id });
    // Two recorded samples, then 5 counted-but-unrecorded failures (the
    // overflow path the Workflow's record-chunk step takes past the cap).
    await appendImportRunError(t.db, run.id, rowSample(1, "Bad date."));
    await appendImportRunError(t.db, run.id, rowSample(2, "Bad date."));
    const { incrementImportRunCounts } = await import("@wellregarded/db");
    await incrementImportRunCounts(t.db, run.id, { failed: 5 });

    const response = await get(
      `/api/imports/runs/${run.id}/failures.csv`,
      caller.token,
      env(bucket),
    );
    const lines = (await response.text()).trimEnd().split("\r\n");
    const note = lines[lines.length - 1];
    expect(note).toContain(
      "5 additional failed rows not individually recorded",
    );
    expect(note).toContain(String(IMPORT_RUN_ERROR_SAMPLE_CAP));
  });

  it("re-checks permission and scoping (shared URLs)", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const owner = await staffCaller("owner");
    const run = await importRun(t.db, { practiceId: owner.practice.id });

    // front_desk of the SAME... different practice — either way, no access:
    // front_desk lacks manage_settings (403), other practices 404.
    const frontDesk = await staffCaller("front_desk");
    const forbidden = await get(
      `/api/imports/runs/${run.id}/failures.csv`,
      frontDesk.token,
      env(bucket),
    );
    expect(forbidden.status).toBe(403);

    const otherOwner = await staffCaller("owner");
    const notFound = await get(
      `/api/imports/runs/${run.id}/failures.csv`,
      otherOwner.token,
      env(bucket),
    );
    expect(notFound.status).toBe(404);
  });

  it("row values that were never stored resolve to blank cells, never guesses", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const caller = await staffCaller("owner");
    // Row 150 is outside the single stored batch (rows 1-CSV_IMPORT_BATCH_SIZE).
    const key = await storeBatch(bucket, caller.practice.id, [
      ["2026-04-01", "row 1"],
    ]);
    const run = await importRun(t.db, {
      practiceId: caller.practice.id,
      rawArtifactKeys: [key],
    });
    const beyond = CSV_IMPORT_BATCH_SIZE + 50;
    await appendImportRunError(t.db, run.id, rowSample(beyond, "Bad values."));

    const response = await get(
      `/api/imports/runs/${run.id}/failures.csv`,
      caller.token,
      env(bucket),
    );
    const lines = (await response.text()).trimEnd().split("\r\n");
    expect(lines[1]).toBe(`${beyond},Bad values.`);
  });
});
