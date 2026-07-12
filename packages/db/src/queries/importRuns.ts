/**
 * `import_runs` helpers (issue #111, Epic #6) — the only sanctioned write
 * paths into the pipeline's provenance table, plus the read queries the
 * import report UI (Epic #8) and settings surfaces consume.
 *
 * Concurrency story: counts are updated with `SET x = x + $n` inside the
 * calling stage's transaction — never read-modify-write — which is the
 * whole story at our volumes. Helpers never hold the run row in a long
 * transaction of their own; stage transactions stay per-message/per-artifact.
 */

import {
  IMPORT_RUN_ERROR_SAMPLE_CAP,
  type ImportRunErrorSample,
  type ImportRunTrigger,
  type SourceKind,
} from "@wellregarded/core";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";

import type { Tx } from "../audit.js";
import type { Db } from "../client.js";
import { importRuns } from "../schema/importRuns.js";

/** An `import_runs` row. */
export type ImportRun = typeof importRuns.$inferSelect;

export interface CreateImportRunInput {
  practiceId: string;
  sourceKind: SourceKind;
  trigger: ImportRunTrigger;
  /** R2 keys of the raw artifacts (#100) this run has stored, if known. */
  rawArtifactKeys?: string[];
}

/**
 * Open a new run in `running` state. Call BEFORE enqueueing any pipeline
 * message that references the run (messages carry `importRunId`, and the
 * DLQ consumer records failures against it).
 */
export async function createImportRun(
  db: Db | Tx,
  input: CreateImportRunInput,
): Promise<ImportRun> {
  const [row] = await db
    .insert(importRuns)
    .values({
      practiceId: input.practiceId,
      sourceKind: input.sourceKind,
      trigger: input.trigger,
      rawArtifactKeys: input.rawArtifactKeys ?? [],
    })
    .returning();
  if (!row) throw new Error("createImportRun: insert returned no row");
  return row;
}

/**
 * Record the raw-artifact keys a run stored, once they are known. The CSV
 * import Workflow (#135) creates its run BEFORE parsing (so failures are
 * visible on a run row), then sets the batch-artifact keys here after the
 * chunk step — and MUST do so before enqueueing any ingest message: the
 * dedupe stage's `conflict_reimport` path re-reads these keys (#106), and
 * a run with none recorded fails that path by contract.
 */
export async function setImportRunArtifactKeys(
  db: Db | Tx,
  importRunId: string,
  rawArtifactKeys: string[],
): Promise<void> {
  await db
    .update(importRuns)
    .set({ rawArtifactKeys })
    .where(eq(importRuns.id, importRunId));
}

/** Count deltas for `incrementImportRunCounts` — all optional, default 0. */
export interface ImportRunCountDelta {
  created?: number;
  merged?: number;
  skipped?: number;
  failed?: number;
}

/**
 * Atomically add to a run's counts (and optionally accumulate numeric
 * `stats` extras) with `SET x = x + $n` — never read-modify-write.
 *
 * Takes the CALLER'S transaction handle (issue #111 requirement): a stage's
 * count update must commit atomically with the row writes it describes, so
 * a mid-artifact failure can never leave half-written counts (#104/#106/
 * #108). Accepts a plain `Db` too for out-of-transaction accounting.
 *
 * `statsPatch` keys are accumulated the same way (`stats.key += n`,
 * missing keys start at 0) — e.g. `{ suspected_duplicates: 2 }`.
 */
export async function incrementImportRunCounts(
  tx: Db | Tx,
  importRunId: string,
  delta: ImportRunCountDelta,
  statsPatch?: Record<string, number>,
): Promise<void> {
  // Accumulate stats keys via nested jsonb_set. Each lookup reads the row's
  // pre-update `stats` (keys are distinct per patch, so that is correct),
  // and the whole UPDATE is atomic under the row lock.
  let statsExpr = sql`${importRuns.stats}`;
  for (const [key, n] of Object.entries(statsPatch ?? {})) {
    statsExpr = sql`jsonb_set(${statsExpr}, ${`{${key}}`}::text[], to_jsonb(coalesce((${importRuns.stats}->>${key})::numeric, 0) + ${n}))`;
  }
  await tx
    .update(importRuns)
    .set({
      created: sql`${importRuns.created} + ${delta.created ?? 0}`,
      merged: sql`${importRuns.merged} + ${delta.merged ?? 0}`,
      skipped: sql`${importRuns.skipped} + ${delta.skipped ?? 0}`,
      failed: sql`${importRuns.failed} + ${delta.failed ?? 0}`,
      stats: statsExpr,
    })
    .where(eq(importRuns.id, importRunId));
}

/**
 * Append one failure sample to `error_samples` (capped at
 * `IMPORT_RUN_ERROR_SAMPLE_CAP` entries, enforced in this SQL) and
 * increment `failed` — the count is the truth past the cap; samples are
 * samples. This is the low-level write `recordPipelineFailure`
 * (`../pipeline.ts`) routes DLQ deliveries through; stages with a run id in
 * hand may call it directly.
 */
export async function appendImportRunError(
  db: Db | Tx,
  importRunId: string,
  sample: ImportRunErrorSample,
): Promise<void> {
  await db
    .update(importRuns)
    .set({
      failed: sql`${importRuns.failed} + 1`,
      errorSamples: sql`CASE
        WHEN jsonb_array_length(${importRuns.errorSamples}) >= ${IMPORT_RUN_ERROR_SAMPLE_CAP}
        THEN ${importRuns.errorSamples}
        ELSE ${importRuns.errorSamples} || ${JSON.stringify([sample])}::jsonb
      END`,
    })
    .where(eq(importRuns.id, importRunId));
}

/**
 * Close a run: sets `finished_at` and derives the terminal status from the
 * counts in one atomic UPDATE — `failed` if there were failures and zero
 * successes, `completed_with_errors` if mixed, `completed` otherwise.
 *
 * LIFECYCLE CONTRACT: whoever owns the run's lifecycle calls this
 * explicitly — the CSV import Workflow (Epic #8) and the GBP poller
 * (Epic #7). There is deliberately no auto-finalize timer; an abandoned run
 * stays `running` and is a bug in its owner, not in this table.
 *
 * Returns the finalized row, or `undefined` when no such run exists.
 */
export async function finalizeImportRun(
  db: Db | Tx,
  importRunId: string,
): Promise<ImportRun | undefined> {
  const [row] = await db
    .update(importRuns)
    .set({
      finishedAt: sql`now()`,
      status: sql`CASE
        WHEN ${importRuns.failed} > 0
         AND ${importRuns.created} + ${importRuns.merged} + ${importRuns.skipped} = 0
        THEN 'failed'::import_run_status
        WHEN ${importRuns.failed} > 0
        THEN 'completed_with_errors'::import_run_status
        ELSE 'completed'::import_run_status
      END`,
    })
    .where(eq(importRuns.id, importRunId))
    .returning();
  return row;
}

/** `getImportRunSummary` result: the run row plus derived display fields. */
export interface ImportRunSummary {
  run: ImportRun;
  /** `finished_at - started_at` in ms; null while the run is `running`. */
  durationMs: number | null;
  /** created + merged + skipped + failed. */
  totalProcessed: number;
  /** The `failed` count (may exceed `errorSamples.length` past the cap). */
  errorCount: number;
  /** First N samples (default 10) — the report page's error preview. */
  errorSamples: ImportRunErrorSample[];
}

/**
 * One-round-trip read for UI consumption (Epic #8's import report page,
 * settings' import list drill-down). Practice-scoped: a run id from another
 * practice returns `undefined`.
 */
export async function getImportRunSummary(
  db: Db | Tx,
  practiceId: string,
  importRunId: string,
  opts?: { errorSampleLimit?: number },
): Promise<ImportRunSummary | undefined> {
  const [run] = await db
    .select()
    .from(importRuns)
    .where(
      and(
        eq(importRuns.id, importRunId),
        eq(importRuns.practiceId, practiceId),
      ),
    )
    .limit(1);
  if (!run) return undefined;
  return {
    run,
    durationMs:
      run.finishedAt === null
        ? null
        : run.finishedAt.getTime() - run.startedAt.getTime(),
    totalProcessed: run.created + run.merged + run.skipped + run.failed,
    errorCount: run.failed,
    errorSamples: run.errorSamples.slice(0, opts?.errorSampleLimit ?? 10),
  };
}

export interface ListImportRunsOptions {
  sourceKind?: SourceKind;
  /** Page size; defaults to 20. */
  limit?: number;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
}

export interface ImportRunPage {
  runs: ImportRun[];
  /** Pass back as `cursor` for the next page; undefined on the last page. */
  nextCursor: string | undefined;
}

// Cursor = `<started_at epoch ms>:<id>` — stable under the
// (started_at DESC, id DESC) sort backing the listing index.
function encodeCursor(run: ImportRun): string {
  return `${run.startedAt.getTime()}:${run.id}`;
}

function decodeCursor(
  cursor: string,
): { startedAt: Date; id: string } | undefined {
  const match = /^(\d+):([0-9a-f-]{36})$/.exec(cursor);
  if (!match || match[1] === undefined || match[2] === undefined)
    return undefined;
  return { startedAt: new Date(Number(match[1])), id: match[2] };
}

/** Newest-first, practice-scoped listing for the settings import list. */
export async function listImportRuns(
  db: Db | Tx,
  practiceId: string,
  options: ListImportRunsOptions = {},
): Promise<ImportRunPage> {
  const limit = options.limit ?? 20;
  const after = options.cursor ? decodeCursor(options.cursor) : undefined;

  const conditions = [eq(importRuns.practiceId, practiceId)];
  if (options.sourceKind) {
    conditions.push(eq(importRuns.sourceKind, options.sourceKind));
  }
  if (after) {
    const keyset = or(
      lt(importRuns.startedAt, after.startedAt),
      and(
        eq(importRuns.startedAt, after.startedAt),
        lt(importRuns.id, after.id),
      ),
    );
    if (keyset) conditions.push(keyset);
  }

  // Fetch one extra row to know whether another page exists.
  const rows = await db
    .select()
    .from(importRuns)
    .where(and(...conditions))
    .orderBy(desc(importRuns.startedAt), desc(importRuns.id))
    .limit(limit + 1);

  const runs = rows.slice(0, limit);
  const last = runs[runs.length - 1];
  return {
    runs,
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor(last)
        : undefined,
  };
}
