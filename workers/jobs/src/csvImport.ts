/**
 * CSV import Workflow core (issue #135, Epic #8) — the durable,
 * resumable orchestration behind `wr-csv-import`, kept free of
 * `cloudflare:workers` imports so it runs under plain Node in tests
 * (same quarantine as ./embeddingBackfill.ts, the repo's Workflow
 * precedent — read that module first).
 *
 * Why a Workflow: a 50MB CSV is tens of thousands of rows; parsing and
 * feeding them through the pipeline must survive Worker eviction,
 * deploys, and transient failures without restarting from row zero.
 * Every phase is a `step.do` with a deterministic name — the engine
 * persists each completed step's return value and, on resume, replays
 * completed steps from storage (their callbacks do NOT re-run):
 *
 *   1. `validate`        — load the confirmed draft, re-validate the
 *      mapping against the STORED headers (defense in depth vs #134's
 *      start endpoint), open the `import_runs` row (trigger `manual`,
 *      sourceKind `csv_import`) and link it onto the draft (#137's
 *      queryable linkage).
 *   2. `chunk`           — parse the whole file from R2 (papaparse via
 *      `forEachCsvRecord`, the same parser config the adapter fixtures
 *      use), validate every row with the SHARED row functions
 *      (`validateCsvRow` — the wizard's preview uses the same ones),
 *      slice rows into batches of {@link CSV_IMPORT_BATCH_SIZE}, and
 *      store each batch as a content-addressed raw artifact. The
 *      checkpoint is the BATCH-KEY LIST (small — Workflows caps step
 *      payloads at 1MiB), never row data: a resume never re-parses.
 *   3. `record-chunk`    — record the batch keys on the run (dedupe's
 *      conflict path re-reads them, #106) and the row-validation
 *      failures (counted `failed`, samples capped per #111). Row errors
 *      do NOT abort the import.
 *   4. `enqueue-batches` — one `IngestMessage` per batch artifact onto
 *      `wr-ingest`. Idempotent by construction: content-addressed
 *      artifact keys + deterministic sourceIds (`sha256(draftId + ":" +
 *      rowNumber)`) + the `(practice_id, source_kind, source_id)` unique
 *      constraint make re-enqueue after a resume safe.
 *   5. drain             — poll `getImportRunSummary` every
 *      {@link DRAIN_POLL_INTERVAL_MS} (`step.sleep`, engine-billed, so
 *      30s not 1s) until `created + merged + skipped + failed >=
 *      totalRows`, capped at {@link MAX_DRAIN_POLLS} (2h) — a tripped
 *      cap records a drain-timeout error (which forces
 *      `completed_with_errors`) instead of spinning forever.
 *   6. `finalize`        — `finalizeImportRun` (status derived from
 *      counts), mark the draft `superseded`, audit `import.completed`.
 *
 * FAILURE SEMANTICS (requirement 4): a step that throws is retried by
 * the engine (`NonRetryableError` from `@wellregarded/core` aborts
 * retries — the Workflows engine matches non-retryable errors by the
 * `NonRetryableError` name). If the run body fails past `validate`, the
 * catch block finalizes the run via `record-workflow-failure` — a run
 * must never sit in `running` forever. The draft is deliberately left
 * `confirmed` on failure so the import can be retried (a retry opens a
 * NEW run and re-links it). Residual risk: if that last-resort step
 * itself exhausts retries, the run does stay `running` — see the
 * sweeper note in docs/csv-import.md (and #137's staleness guard).
 *
 * The split (orchestration in {@link runCsvImport} vs per-step work in
 * {@link createCsvImportDeps}) is the test seam, exactly as in the
 * embedding backfill: unit tests drive the orchestration with the
 * checkpoint-memoizing fake step; integration tests drive the real deps
 * against Postgres + in-memory R2.
 */

import type { ColumnMapping } from "@wellregarded/core";
import {
  columnMappingSchema,
  IMPORT_RUN_ERROR_SAMPLE_CAP,
  type ImportRunErrorSample,
  NonRetryableError,
  unknownMappingColumns,
} from "@wellregarded/core";
import {
  appendImportRunError,
  audit,
  createImportRun,
  type Db,
  finalizeImportRun,
  getImportDraft,
  getImportRunSummary,
  incrementImportRunCounts,
  linkImportRunToDraft,
  markImportDraftSuperseded,
  setImportRunArtifactKeys,
} from "@wellregarded/db";
import {
  buildCsvImportBatchArtifact,
  CSV_IMPORT_BATCH_SIZE,
  forEachCsvRecord,
  putRawArtifact,
  type RawArtifactBucket,
  type RawImportBucket,
  validateCsvRow,
} from "@wellregarded/sources";
import { z } from "zod";

/** Poll cadence while awaiting pipeline drain (step.sleep is billed — 30s, not 1s). */
export const DRAIN_POLL_INTERVAL_MS = 30_000;

/** Drain wall-clock cap: 240 polls x 30s = 2h, well inside step-count limits. */
export const MAX_DRAIN_POLLS = 240;

/** Audit actor for everything this Workflow writes (issue #46 vocab). */
export const CSV_IMPORT_ACTOR = {
  type: "system",
  id: "jobs:csv-import",
} as const;

/**
 * Workflow instance params — what #134's `POST /imports/csv/:draftId/start`
 * endpoint passes to `CSV_IMPORT.create({ params })`.
 */
const csvImportParamsSchema = z.object({
  importDraftId: z.uuid(),
  practiceId: z.uuid(),
  /** Trace id from the starting request (issue #64), propagated to every
   * ingest message; minted in `validate` when absent. */
  requestId: z.string().min(1).optional(),
});

export type CsvImportParams = z.infer<typeof csvImportParamsSchema>;

/** Validate the payload up front — garbage params can never succeed. */
export function resolveCsvImportParams(payload: unknown): CsvImportParams {
  const parsed = csvImportParamsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new NonRetryableError(
      `csv-import: invalid params: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/**
 * `validate` step checkpoint. Carries the mapping SNAPSHOT the whole run
 * executes: later draft edits cannot change a running import (#135
 * implementation note). Plain JSON — the engine persists it.
 */
export interface CsvValidateResult {
  importRunId: string;
  r2Key: string;
  headers: string[];
  mapping: ColumnMapping;
  /** Propagated (or minted) trace id for every downstream message. */
  requestId: string;
}

/**
 * `chunk` step checkpoint: batch KEYS (content-addressed, ~100 bytes
 * each — 500 keys for a 50k-row file stays far under the engine's 1MiB
 * step-payload cap) plus row accounting. Never row data.
 */
export interface CsvChunkResult {
  batchKeys: string[];
  /** Data rows in the file (1-based rows; header excluded). */
  totalRows: number;
  /** Rows that failed the shared row validation (recorded, not aborted). */
  failedRows: number;
  /** First ≤{@link IMPORT_RUN_ERROR_SAMPLE_CAP} row failures, one per row. */
  errorSamples: ImportRunErrorSample[];
}

export interface CsvImportSummary {
  importRunId: string;
  /** Terminal `import_runs.status` after finalize. */
  status: string;
  created: number;
  merged: number;
  skipped: number;
  failed: number;
  totalRows: number;
  batches: number;
  /** False when the drain cap tripped (run carries a drain-timeout note). */
  drained: boolean;
}

/**
 * Structural subset of the Workflows `WorkflowStep` this run uses, so
 * tests inject the checkpoint-memoizing fake (test/support/fakeStep.ts).
 * Generic — unlike the backfill's monomorphic step, several checkpoint
 * shapes flow through — so the thin Workflow class bridges the real
 * `step.do` (typed with `Rpc.Serializable`) with one commented cast.
 */
export interface CsvImportStep {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, durationMs: number): Promise<void>;
}

/** The per-step work, injectable for tests; production wiring below. */
export interface CsvImportDeps {
  validate(params: CsvImportParams): Promise<CsvValidateResult>;
  chunk(
    params: CsvImportParams,
    validated: CsvValidateResult,
  ): Promise<CsvChunkResult>;
  recordChunk(importRunId: string, chunk: CsvChunkResult): Promise<void>;
  /** Returns the number of messages sent. */
  enqueueBatches(
    params: CsvImportParams,
    validated: CsvValidateResult,
    batchKeys: string[],
  ): Promise<number>;
  /** Current `created + merged + skipped + failed` for the run. */
  pollProcessedCount(practiceId: string, importRunId: string): Promise<number>;
  recordDrainTimeout(
    importRunId: string,
    info: { totalRows: number; processed: number },
  ): Promise<void>;
  finalize(
    params: CsvImportParams,
    validated: CsvValidateResult,
    chunk: CsvChunkResult,
    drained: boolean,
  ): Promise<CsvImportSummary>;
  /** Last-resort finalization so a failed instance never leaves the run `running`. */
  recordWorkflowFailure(
    params: CsvImportParams,
    importRunId: string,
    message: string,
  ): Promise<void>;
}

/**
 * The orchestration: deterministic step names (the engine keys its
 * checkpoint cache by name — that is what makes replay skip completed
 * work), plain-JSON step returns, `step.sleep` between drain polls.
 */
export async function runCsvImport(
  step: CsvImportStep,
  deps: CsvImportDeps,
  params: CsvImportParams,
): Promise<CsvImportSummary> {
  const validated = await step.do("validate", () => deps.validate(params));

  try {
    const chunked = await step.do("chunk", () => deps.chunk(params, validated));
    await step.do("record-chunk", () =>
      deps.recordChunk(validated.importRunId, chunked),
    );
    await step.do("enqueue-batches", () =>
      deps.enqueueBatches(params, validated, chunked.batchKeys),
    );

    // Await pipeline drain: counts move as the pipeline stages process
    // the batches (normalize counts `created`, dedupe `merged`/`skipped`,
    // the DLQ consumer `failed`), on top of the row failures already
    // recorded by record-chunk. `>=` on purpose: re-deliveries can push
    // dedupe counts past totalRows, and that still means "drained".
    let drained = chunked.totalRows === 0;
    for (let poll = 0; !drained && poll < MAX_DRAIN_POLLS; poll++) {
      const processed = await step.do(`poll-import-counts-${poll}`, () =>
        deps.pollProcessedCount(params.practiceId, validated.importRunId),
      );
      if (processed >= chunked.totalRows) {
        drained = true;
        break;
      }
      await step.sleep(`drain-pause-${poll}`, DRAIN_POLL_INTERVAL_MS);
    }
    if (!drained) {
      const processed = await step.do("final-count-before-timeout", () =>
        deps.pollProcessedCount(params.practiceId, validated.importRunId),
      );
      await step.do("record-drain-timeout", () =>
        deps.recordDrainTimeout(validated.importRunId, {
          totalRows: chunked.totalRows,
          processed,
        }),
      );
    }

    return await step.do("finalize", () =>
      deps.finalize(params, validated, chunked, drained),
    );
  } catch (error) {
    // Requirement 4: never leave the run stuck in `running`. This is a
    // real step so the engine retries the finalization itself; the draft
    // stays `confirmed` so the import can be started again.
    await step.do("record-workflow-failure", () =>
      deps.recordWorkflowFailure(
        params,
        validated.importRunId,
        error instanceof Error ? error.message : String(error),
      ),
    );
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Production dependencies
// ---------------------------------------------------------------------------

/**
 * What the real deps run against. `withDb` opens a connection per CALL
 * and closes it before returning — nothing stateful may outlive a step
 * (the instance can sleep for minutes and resume in another isolate);
 * the Workflow class wires this to a per-call Hyperdrive client, tests
 * to the harness database.
 */
export interface CsvImportResources {
  withDb<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** The uploaded-CSV bucket (`{practiceId}/imports/{sha256}.csv`, #133). */
  rawImports: RawImportBucket;
  /** The pipeline's raw-artifact bucket the batch envelopes land in (#100). */
  rawArtifacts: RawArtifactBucket;
  /** `wr-ingest` producer. */
  ingest: { send(body: unknown): Promise<void> };
}

function sameHeaders(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

export function createCsvImportDeps(
  resources: CsvImportResources,
): CsvImportDeps {
  return {
    validate: (params) =>
      resources.withDb(async (db) => {
        const draft = await getImportDraft(
          db,
          params.practiceId,
          params.importDraftId,
        );
        if (draft === undefined) {
          throw new NonRetryableError(
            `csv-import: draft ${params.importDraftId} not found for ` +
              `practice ${params.practiceId}`,
          );
        }
        if (draft.status !== "confirmed") {
          throw new NonRetryableError(
            `csv-import: draft ${draft.id} is "${draft.status}" — only ` +
              "confirmed drafts are importable (#134's start endpoint owns " +
              "the confirm transition)",
          );
        }
        // Defense in depth vs #134 (requirement 1.1): re-validate the
        // mapping's shape and its columns against the STORED headers —
        // the Workflow must never execute a mapping the server would
        // reject.
        const mapping = columnMappingSchema.safeParse(draft.mapping);
        if (!mapping.success) {
          throw new NonRetryableError(
            `csv-import: draft ${draft.id} has no valid mapping: ` +
              z.prettifyError(mapping.error),
          );
        }
        const unknown = unknownMappingColumns(mapping.data, draft.headers);
        if (unknown.length > 0) {
          throw new NonRetryableError(
            `csv-import: draft ${draft.id} mapping references columns the ` +
              `file does not have: ${unknown
                .map(({ field, column }) => `${field} -> "${column}"`)
                .join(", ")}`,
          );
        }

        const requestId =
          params.requestId ?? `csv-import-${crypto.randomUUID()}`;
        const run = await db.transaction(async (tx) => {
          // Run + draft linkage + audit commit atomically: a partially
          // created run can never be observed (a retried validate step
          // therefore cannot leak a half-linked run).
          const created = await createImportRun(tx, {
            practiceId: params.practiceId,
            sourceKind: "csv_import",
            trigger: "manual",
          });
          await linkImportRunToDraft(tx, draft.id, created.id);
          await audit(tx, {
            practiceId: params.practiceId,
            actor: CSV_IMPORT_ACTOR,
            action: "import.started",
            entityType: "import_runs",
            entityId: created.id,
            payload: {
              importDraftId: draft.id,
              r2Key: draft.r2Key,
              byteSize: draft.byteSize,
              requestId,
            },
          });
          return created;
        });

        return {
          importRunId: run.id,
          r2Key: draft.r2Key,
          headers: draft.headers,
          mapping: mapping.data,
          requestId,
        };
      }),

    chunk: async (params, validated) => {
      const object = await resources.rawImports.get(validated.r2Key);
      if (object === null) {
        // Content-addressed and never deleted (#100 retention rule): a
        // missing upload can never appear by waiting.
        throw new NonRetryableError(
          `csv-import: uploaded file ${validated.r2Key} is missing from R2`,
        );
      }
      // MEMORY (the issue's one memory-critical step, sized deliberately):
      // the decoded text (~file size; ≤50MB by the upload cap #133) plus
      // the serialized batch envelopes (≈ text size, flushed per batch —
      // rows never accumulate beyond the current batch) peak around 2x
      // the file, comfortably inside the 128MB isolate. papaparse runs in
      // `step` mode over the string, so parsed records are never
      // materialized as one array.
      const text = await object.text();

      const serializedBatches: string[] = [];
      let batchRows: string[][] = [];
      let totalRows = 0;
      let failedRows = 0;
      const errorSamples: ImportRunErrorSample[] = [];
      let headerMismatch = false;

      const flush = () => {
        if (batchRows.length === 0) return;
        const batchIndex = serializedBatches.length;
        // Serialize NOW and free the row arrays; putRawArtifact hashes
        // these exact bytes, so the key derivation happens on the same
        // string (issue #100 rule: serialize once).
        serializedBatches.push(
          JSON.stringify(
            buildCsvImportBatchArtifact({
              practiceId: params.practiceId,
              draftId: params.importDraftId,
              batchIndex,
              firstRowNumber: batchIndex * CSV_IMPORT_BATCH_SIZE + 1,
              headers: validated.headers,
              mapping: validated.mapping,
              rows: batchRows,
            }),
          ),
        );
        batchRows = [];
      };

      forEachCsvRecord(text, {
        onHeader: (headers) => {
          // Defense in depth: the draft stored these headers at upload
          // time and the object is content-addressed — a mismatch means
          // the draft points at the wrong file.
          if (!sameHeaders(headers, validated.headers)) headerMismatch = true;
        },
        onRow: (row, rowNumber) => {
          if (headerMismatch) return;
          totalRows += 1;
          const result = validateCsvRow(
            validated.mapping,
            validated.headers,
            row,
            rowNumber,
          );
          if (!result.ok) {
            // Row errors never abort the batch (#135 requirement 2):
            // count the ROW failed, keep a capped sample, and still ship
            // the row in its batch (the adapter skips it
            // deterministically via the same shared validator).
            failedRows += 1;
            if (errorSamples.length < IMPORT_RUN_ERROR_SAMPLE_CAP) {
              errorSamples.push({
                stage: "import",
                message: `Row ${rowNumber}: ${result.errors
                  .map((e) => e.message)
                  .join(" ")}`,
                payloadRef: `row:${rowNumber}`,
                occurredAt: new Date().toISOString(),
              });
            }
          }
          batchRows.push(row);
          if (batchRows.length >= CSV_IMPORT_BATCH_SIZE) flush();
        },
      });
      flush();

      if (headerMismatch) {
        throw new NonRetryableError(
          `csv-import: parsed header row of ${validated.r2Key} does not ` +
            "match the draft's stored headers — the draft does not " +
            "describe this file",
        );
      }

      const batchKeys: string[] = [];
      for (const content of serializedBatches) {
        // Content-addressed put: identical envelope ⇒ identical key ⇒ a
        // retried chunk step re-writes nothing (idempotent by #100).
        const { key } = await putRawArtifact(resources.rawArtifacts, {
          practiceId: params.practiceId,
          sourceKind: "csv_import",
          content,
        });
        batchKeys.push(key);
      }
      return { batchKeys, totalRows, failedRows, errorSamples };
    },

    recordChunk: (importRunId, chunk) =>
      resources.withDb((db) =>
        db.transaction(async (tx) => {
          // One transaction so a retried step re-runs all-or-nothing.
          // (Residual commit-vs-checkpoint race — the engine could crash
          // between this commit and the step checkpoint — would re-append
          // the samples; counts stay honest enough and the report caps
          // samples anyway.)
          //
          // MUST happen before enqueue-batches: dedupe's conflict path
          // re-reads the run's artifact keys (#106/#111 contract).
          await setImportRunArtifactKeys(tx, importRunId, chunk.batchKeys);
          for (const sample of chunk.errorSamples) {
            await appendImportRunError(tx, importRunId, sample);
          }
          const overflow = chunk.failedRows - chunk.errorSamples.length;
          if (overflow > 0) {
            await incrementImportRunCounts(tx, importRunId, {
              failed: overflow,
            });
          }
        }),
      ),

    enqueueBatches: async (params, validated, batchKeys) => {
      for (const rawArtifactKey of batchKeys) {
        // Store-before-enqueue holds: every key was durably written by
        // the (already checkpointed) chunk step.
        await resources.ingest.send({
          importRunId: validated.importRunId,
          rawArtifactKey,
          sourceKind: "csv_import",
          practiceId: params.practiceId,
          requestId: validated.requestId,
        });
      }
      return batchKeys.length;
    },

    pollProcessedCount: (practiceId, importRunId) =>
      resources.withDb(async (db) => {
        const summary = await getImportRunSummary(db, practiceId, importRunId);
        if (summary === undefined) {
          throw new NonRetryableError(
            `csv-import: import run ${importRunId} disappeared mid-drain`,
          );
        }
        return summary.totalProcessed;
      }),

    recordDrainTimeout: (importRunId, info) =>
      resources.withDb((db) =>
        // Also increments `failed`, which is what forces the terminal
        // status to `completed_with_errors` (issue #135 step 4) — a
        // timed-out run must never present as a clean `completed`.
        appendImportRunError(db, importRunId, {
          stage: "import",
          message:
            `Import drain timed out after ${(MAX_DRAIN_POLLS * DRAIN_POLL_INTERVAL_MS) / 60_000} minutes: ` +
            `${info.processed} of ${info.totalRows} rows accounted for. ` +
            "The remaining rows may still complete in the background; " +
            "counts on this report can keep moving.",
          payloadRef: importRunId,
          occurredAt: new Date().toISOString(),
        }),
      ),

    finalize: (params, validated, chunk, drained) =>
      resources.withDb((db) =>
        db.transaction(async (tx) => {
          const run = await finalizeImportRun(tx, validated.importRunId);
          if (run === undefined) {
            throw new NonRetryableError(
              `csv-import: import run ${validated.importRunId} disappeared at finalize`,
            );
          }
          // The draft is spent: re-importing means a fresh upload → a new
          // draft (deterministic sourceIds are per-draft, so a corrected
          // re-upload dedupes fuzzily rather than colliding exactly).
          await markImportDraftSuperseded(tx, params.importDraftId);
          const summary: CsvImportSummary = {
            importRunId: run.id,
            status: run.status,
            created: run.created,
            merged: run.merged,
            skipped: run.skipped,
            failed: run.failed,
            totalRows: chunk.totalRows,
            batches: chunk.batchKeys.length,
            drained,
          };
          await audit(tx, {
            practiceId: params.practiceId,
            actor: CSV_IMPORT_ACTOR,
            action: "import.completed",
            entityType: "import_runs",
            entityId: run.id,
            payload: { importDraftId: params.importDraftId, ...summary },
          });
          return summary;
        }),
      ),

    recordWorkflowFailure: (params, importRunId, message) =>
      resources.withDb((db) =>
        db.transaction(async (tx) => {
          await appendImportRunError(tx, importRunId, {
            stage: "import",
            message: `Import workflow failed: ${message}`,
            payloadRef: params.importDraftId,
            occurredAt: new Date().toISOString(),
          });
          const run = await finalizeImportRun(tx, importRunId);
          await audit(tx, {
            practiceId: params.practiceId,
            actor: CSV_IMPORT_ACTOR,
            action: "import.failed",
            entityType: "import_runs",
            entityId: importRunId,
            payload: {
              importDraftId: params.importDraftId,
              message,
              status: run?.status ?? "missing",
            },
          });
        }),
      ),
  };
}
