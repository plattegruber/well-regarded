/**
 * The `wr-csv-import` Workflow entrypoint (issue #135) — same quarantine
 * and thin-class rules as ./embeddingBackfill.workflow.ts (the repo's
 * Workflow precedent; its module doc explains the whole pattern):
 *
 * - imported ONLY from src/worker.ts (`cloudflare:workers` cannot resolve
 *   under plain Node, and unit tests import the non-entry modules);
 * - the class only resolves params, wires real resources (per-call
 *   Hyperdrive connections, the two R2 buckets, the ingest producer),
 *   and delegates to `runCsvImport` — ALL logic lives in ./csvImport.ts;
 * - step callbacks return plain JSON (`CsvValidateResult`,
 *   `CsvChunkResult`, ... are all plain data) — the engine persists them
 *   as checkpoints;
 * - nothing stateful outlives a step: `withDb` opens and closes a
 *   connection per dependency call.
 *
 * Missing bindings throw before the first step: the engine retries
 * steps, not the `run` preamble, and a misconfigured deploy should fail
 * the instance loudly rather than spin.
 *
 * Triggering (see docs/csv-import.md): production, #134's
 * `POST /imports/csv/:draftId/start` calls `CSV_IMPORT.create({ params:
 * { importDraftId, practiceId } })`; local, `POST
 * /__local/trigger/csv-import` under `wrangler dev`.
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { createDb } from "@wellregarded/db";

import type { JobsBindings } from "./bindings";
import {
  type CsvImportParams,
  type CsvImportStep,
  type CsvImportSummary,
  createCsvImportDeps,
  resolveCsvImportParams,
  runCsvImport,
} from "./csvImport";

export class CsvImport extends WorkflowEntrypoint<
  JobsBindings,
  CsvImportParams
> {
  override async run(
    event: WorkflowEvent<CsvImportParams>,
    step: WorkflowStep,
  ): Promise<CsvImportSummary> {
    const env = this.env;
    const hyperdrive = env.HYPERDRIVE;
    if (!hyperdrive) {
      throw new Error(
        "csv-import: HYPERDRIVE binding is missing — the import needs " +
          "Postgres (see workers/jobs/wrangler.jsonc)",
      );
    }
    const rawImports = env.RAW_IMPORTS;
    if (!rawImports) {
      throw new Error(
        "csv-import: RAW_IMPORTS binding is missing — the import reads the " +
          "uploaded CSV from R2 (see workers/jobs/wrangler.jsonc)",
      );
    }
    const rawArtifacts = env.RAW_ARTIFACTS;
    if (!rawArtifacts) {
      throw new Error(
        "csv-import: RAW_ARTIFACTS binding is missing — batch artifacts " +
          "land in the pipeline's raw bucket (see workers/jobs/wrangler.jsonc)",
      );
    }
    const ingest = env.INGEST_QUEUE;
    if (!ingest) {
      throw new Error(
        "csv-import: INGEST_QUEUE binding is missing — batches enter the " +
          "pipeline through wr-ingest (see workers/jobs/wrangler.jsonc)",
      );
    }

    const params = resolveCsvImportParams(event.payload);
    const deps = createCsvImportDeps({
      withDb: async (fn) => {
        // Per-call connection: see the module doc.
        const { db, sql } = createDb(hyperdrive.connectionString);
        try {
          return await fn(db);
        } finally {
          await sql.end({ timeout: 5 });
        }
      },
      rawImports,
      rawArtifacts,
      ingest,
    });

    const importStep: CsvImportStep = {
      // Bridge the real `step.do` (typed with `Rpc.Serializable<T>`) to
      // the generic seam: every CsvImport checkpoint is plain JSON data,
      // so the constraint holds by construction; the cast only erases
      // what the compiler cannot see across the generic boundary.
      do: <T>(name: string, callback: () => Promise<T>) =>
        step.do(name, callback as () => Promise<never>) as Promise<T>,
      sleep: (name, durationMs) => step.sleep(name, durationMs),
    };

    return runCsvImport(importStep, deps, params);
  }
}
