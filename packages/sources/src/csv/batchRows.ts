/**
 * Failed-row reconstruction for the import report (issue #137, Epic #8).
 *
 * An import run's `error_samples` record row-validation failures as
 * `payloadRef: "row:<n>"` plus a plain-language message — the raw cell
 * values are deliberately NOT copied into the run row. They don't need to
 * be: the CSV Workflow ships every row (failing rows included) inside the
 * content-addressed batch artifacts it stores in R2 and records on
 * `import_runs.raw_artifact_keys`, so the original values are always
 * reconstructable from provenance. These helpers do that reconstruction
 * for the report page's error table and the failures-CSV download.
 *
 * Batch addressing is arithmetic, not a search: the Workflow stores
 * batches in order (`raw_artifact_keys[i]` is batch `i`) and each batch
 * holds `CSV_IMPORT_BATCH_SIZE` consecutive rows starting at
 * `firstRowNumber = i * CSV_IMPORT_BATCH_SIZE + 1`, so row `n` lives in
 * batch `floor((n - 1) / CSV_IMPORT_BATCH_SIZE)`. Only the batches the
 * requested rows touch are fetched.
 *
 * Honesty rules (the report must never guess):
 * - a row whose batch artifact is missing/unparseable resolves to no
 *   values (callers render "not recoverable"), never a wrong row;
 * - non-CSV runs (manual entry, Google polls) have no row-numbered
 *   samples, so callers get an empty result and fall back to the sample's
 *   `payloadRef`.
 */

import type { RawArtifactBucket } from "../rawArtifacts.js";
import {
  CSV_IMPORT_BATCH_SIZE,
  csvImportBatchArtifactSchema,
} from "./schema.js";

/** `payloadRef` of a row-validation failure — see workers/jobs csvImport. */
const ROW_REF_PATTERN = /^row:(\d+)$/;

/** Parse a `row:<n>` payloadRef; null for any other ref shape. */
export function parseRowRef(payloadRef: string): number | null {
  const match = ROW_REF_PATTERN.exec(payloadRef);
  if (!match || match[1] === undefined) return null;
  const rowNumber = Number(match[1]);
  return Number.isSafeInteger(rowNumber) && rowNumber >= 1 ? rowNumber : null;
}

export interface CsvBatchRowLookup {
  /** The file's header row, from the first batch that parsed. */
  headers: string[] | undefined;
  /** Row number → verbatim cell values, for every recoverable row asked. */
  rows: Map<number, string[]>;
}

/**
 * Fetch the original cell values for the given 1-based data-row numbers
 * from a run's ordered batch-artifact keys. Missing or unparseable
 * batches are skipped (their rows are simply absent from the result).
 */
export async function readCsvBatchRows(
  bucket: RawArtifactBucket,
  batchKeys: readonly string[],
  rowNumbers: readonly number[],
): Promise<CsvBatchRowLookup> {
  const byBatch = new Map<number, number[]>();
  for (const rowNumber of rowNumbers) {
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) continue;
    const batchIndex = Math.floor((rowNumber - 1) / CSV_IMPORT_BATCH_SIZE);
    if (batchIndex >= batchKeys.length) continue;
    const rows = byBatch.get(batchIndex) ?? [];
    rows.push(rowNumber);
    byBatch.set(batchIndex, rows);
  }

  let headers: string[] | undefined;
  const rows = new Map<number, string[]>();
  for (const [batchIndex, wanted] of byBatch) {
    const key = batchKeys[batchIndex];
    if (key === undefined) continue;
    const object = await bucket.get(key);
    if (object === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await object.text());
    } catch {
      continue;
    }
    const artifact = csvImportBatchArtifactSchema.safeParse(parsed);
    if (!artifact.success) continue;
    headers ??= artifact.data.headers;
    for (const rowNumber of wanted) {
      const row = artifact.data.rows[rowNumber - artifact.data.firstRowNumber];
      if (row !== undefined) rows.set(rowNumber, row);
    }
  }
  return { headers, rows };
}
