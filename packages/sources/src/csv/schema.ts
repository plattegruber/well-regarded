/**
 * The CSV batch artifact envelope (issue #135, Epic #8) — the contract
 * between the import Workflow's chunk step (`workers/jobs`) and the
 * `csvImportAdapter`, mirroring the Google poller envelope precedent
 * (#125, `../google/schema.ts`).
 *
 * One stored artifact = one batch of up to {@link CSV_IMPORT_BATCH_SIZE}
 * consecutive data rows from one confirmed import draft. The adapter is
 * pure (no network, no DB), so everything normalization needs rides the
 * envelope:
 *
 * ```jsonc
 * {
 *   "kind": "csv.import.batch",     // discriminator, always this
 *   "envelopeVersion": 1,           // bump on breaking change
 *   "practiceId": "<uuid>",         // tenant provenance
 *   "draftId": "<uuid>",            // the confirmed import_drafts row —
 *   //   sourceId derivation input (sha256(draftId + ":" + rowNumber))
 *   "batchIndex": 0,                // 0-based batch position in the file
 *   "firstRowNumber": 1,            // 1-based data-row number of rows[0]
 *   "headers": ["Date", "Review"],  // the draft's stored header row
 *   "mapping": { ... },             // the ColumnMapping AS CONFIRMED —
 *   //   embedded so the pipeline normalizes with the confirmed snapshot,
 *   //   immune to later draft edits (#135 implementation note)
 *   "rows": [["4/1/2026", "..."]]   // parsed data rows, VERBATIM slices
 * }                                 //   of the file (invalid rows too —
 * //   the adapter skips what fails the shared row validation; the
 * //   Workflow already recorded those failures on the import run)
 * ```
 *
 * Strict schemas throughout (unlike the Google envelope's loose payload):
 * we author every byte of this envelope, so an unknown field is a bug on
 * our side and must fail loudly.
 */

import { columnMappingSchema } from "@wellregarded/core";
import { z } from "zod";

/** Rows per batch = rows per artifact = rows per ingest message (#135). */
export const CSV_IMPORT_BATCH_SIZE = 100;

export const CSV_IMPORT_BATCH_KIND = "csv.import.batch";

export const CSV_IMPORT_ENVELOPE_VERSION = 1;

export const csvImportBatchArtifactSchema = z.strictObject({
  kind: z.literal(CSV_IMPORT_BATCH_KIND),
  envelopeVersion: z.literal(CSV_IMPORT_ENVELOPE_VERSION),
  practiceId: z.uuid(),
  draftId: z.uuid(),
  batchIndex: z.int().nonnegative(),
  /** 1-based data-row number of `rows[0]` (header excluded — see validateRow.ts). */
  firstRowNumber: z.int().positive(),
  headers: z.array(z.string()),
  mapping: columnMappingSchema,
  rows: z.array(z.array(z.string())),
});

export type CsvImportBatchArtifact = z.infer<
  typeof csvImportBatchArtifactSchema
>;

/** Builder the Workflow's chunk step uses — one place owns the literals. */
export function buildCsvImportBatchArtifact(input: {
  practiceId: string;
  draftId: string;
  batchIndex: number;
  firstRowNumber: number;
  headers: string[];
  mapping: CsvImportBatchArtifact["mapping"];
  rows: string[][];
}): CsvImportBatchArtifact {
  return {
    kind: CSV_IMPORT_BATCH_KIND,
    envelopeVersion: CSV_IMPORT_ENVELOPE_VERSION,
    ...input,
  };
}
