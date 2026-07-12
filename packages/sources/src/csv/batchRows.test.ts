import { describe, expect, it } from "vitest";

import { putRawArtifact } from "../rawArtifacts.js";
import { InMemoryRawArtifactBucket } from "../testing/inMemoryBucket.js";
import { parseRowRef, readCsvBatchRows } from "./batchRows.js";
import {
  buildCsvImportBatchArtifact,
  CSV_IMPORT_BATCH_SIZE,
} from "./schema.js";

const PRACTICE_ID = "0f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const DRAFT_ID = "1f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const HEADERS = ["Date", "Review"];

function batch(batchIndex: number, rows: string[][]) {
  return buildCsvImportBatchArtifact({
    practiceId: PRACTICE_ID,
    draftId: DRAFT_ID,
    batchIndex,
    firstRowNumber: batchIndex * CSV_IMPORT_BATCH_SIZE + 1,
    headers: HEADERS,
    mapping: {
      occurredAt: { column: "Date", dateFormat: "ISO" },
      text: { column: "Review" },
    },
    rows,
  });
}

async function store(bucket: InMemoryRawArtifactBucket, artifact: unknown) {
  const { key } = await putRawArtifact(bucket, {
    practiceId: PRACTICE_ID,
    sourceKind: "csv_import",
    content: JSON.stringify(artifact),
  });
  return key;
}

describe("parseRowRef", () => {
  it("parses row refs and rejects everything else", () => {
    expect(parseRowRef("row:1")).toBe(1);
    expect(parseRowRef("row:472")).toBe(472);
    expect(parseRowRef("row:0")).toBeNull();
    expect(parseRowRef("row:-3")).toBeNull();
    expect(parseRowRef("row:abc")).toBeNull();
    expect(parseRowRef(`${PRACTICE_ID}/manual/abc.json`)).toBeNull();
  });
});

describe("readCsvBatchRows", () => {
  it("resolves rows across batches by arithmetic addressing", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const rows0 = Array.from({ length: CSV_IMPORT_BATCH_SIZE }, (_, i) => [
      `d${i + 1}`,
      `text ${i + 1}`,
    ]);
    const rows1 = [
      ["d101", "text 101"],
      ["d102", "text 102"],
    ];
    const keys = [
      await store(bucket, batch(0, rows0)),
      await store(bucket, batch(1, rows1)),
    ];

    const lookup = await readCsvBatchRows(bucket, keys, [2, 101]);
    expect(lookup.headers).toEqual(HEADERS);
    expect(lookup.rows.get(2)).toEqual(["d2", "text 2"]);
    expect(lookup.rows.get(101)).toEqual(["d101", "text 101"]);
    // Only requested rows are materialized.
    expect(lookup.rows.size).toBe(2);
  });

  it("skips out-of-range rows, missing keys, and unparseable batches", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const goodKey = await store(bucket, batch(0, [["d1", "text 1"]]));
    const junkKey = await store(bucket, { not: "a batch" });

    const lookup = await readCsvBatchRows(
      bucket,
      [goodKey, junkKey],
      [1, 150, 9_999],
    );
    expect(lookup.rows.get(1)).toEqual(["d1", "text 1"]);
    expect(lookup.rows.has(150)).toBe(false);
    expect(lookup.rows.has(9_999)).toBe(false);
  });

  it("returns an empty lookup when there is nothing to fetch", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const lookup = await readCsvBatchRows(bucket, [], [1, 2]);
    expect(lookup.headers).toBeUndefined();
    expect(lookup.rows.size).toBe(0);
  });
});
