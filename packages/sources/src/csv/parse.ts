/**
 * Full-file CSV record iteration for the import Workflow's chunk step
 * (issue #135) — papaparse in `step` mode, so records are delivered one at
 * a time and never accumulated into a result array. The same parser
 * settings as the upload preview (`workers/api/src/imports/csv.ts`):
 * delimiter auto-detection (semicolon European exports are real), greedy
 * empty-line skipping, and RFC-faithful quoted fields (quoted newlines
 * stay inside one record).
 *
 * Lives in `@wellregarded/sources` (not `workers/jobs`) so the parsing
 * behavior the adapter's contract fixtures are built with is the exact
 * behavior the Workflow runs — one config, no drift. papaparse is
 * DOM-free and Workers-runtime clean (already in production use by
 * `workers/api`).
 */

import Papa from "papaparse";

import { FIRST_CSV_DATA_ROW_NUMBER } from "./validateRow.js";

export interface CsvRecordHandlers {
  /** The header row, exactly as parsed (after BOM stripping). */
  onHeader(headers: string[]): void;
  /** One data row; `rowNumber` is 1-based, header excluded. */
  onRow(row: string[], rowNumber: number): void;
}

/**
 * Iterate every record of a decoded CSV text. Returns the number of data
 * rows seen. A leading UTF-8 BOM is stripped (TextDecoder already does
 * this for byte input; the guard here covers string fixtures and any
 * decoder that was told not to).
 */
export function forEachCsvRecord(
  text: string,
  handlers: CsvRecordHandlers,
): number {
  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let headerSeen = false;
  let rowNumber = FIRST_CSV_DATA_ROW_NUMBER - 1;
  Papa.parse<string[]>(content, {
    delimiter: "", // auto-detect, same as the upload preview
    skipEmptyLines: "greedy",
    step: (result) => {
      if (!headerSeen) {
        headerSeen = true;
        handlers.onHeader(result.data);
        return;
      }
      rowNumber += 1;
      handlers.onRow(result.data, rowNumber);
    },
  });
  return rowNumber;
}
