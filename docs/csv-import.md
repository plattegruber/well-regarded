# CSV import Workflow (`wr-csv-import`)

The durable Cloudflare Workflow in `workers/jobs` that executes a
confirmed CSV import draft: validate → chunk → enqueue → await drain →
finalize ([#135](https://github.com/plattegruber/well-regarded/issues/135),
Epic #8). It follows the Workflow pattern established by the embedding
backfill — read [embedding-backfill.md](embedding-backfill.md) § "The
Workflow pattern" first; this doc covers only what is specific to the
import.

## Why a Workflow

A 50MB CSV is tens of thousands of rows; parsing and feeding them through
the ingestion pipeline must survive Worker eviction, deploys, and
transient failures without restarting from row zero. Each phase is a
`step.do` checkpoint with a deterministic name: on resume, the engine
replays completed steps from storage (their callbacks do not re-run) and
continues at the first unfinished one. The chunk step's checkpoint is the
**batch-key list**, never row data — a resumed instance re-parses
nothing (and stays far under the engine's 1MiB step-payload cap).

## What it does

Params (passed by #134's `POST /imports/csv/:draftId/start` via
`CSV_IMPORT.create({ params })`): `{ importDraftId, practiceId,
requestId? }`.

1. **validate** — loads the draft (practice-scoped), requires `status =
   confirmed`, re-validates the `ColumnMapping` shape AND its columns
   against the draft's stored headers (defense in depth vs the start
   endpoint), then atomically: opens the `import_runs` row (trigger
   `manual`, sourceKind `csv_import`), stores `import_runs.id` on the
   draft (the queryable linkage #137 follows), audits `import.started`.
   The checkpoint carries the **mapping snapshot** — later draft edits
   cannot change a running import.
2. **chunk** — reads the uploaded file from R2 (`RAW_IMPORTS`), parses it
   with papaparse in step mode (`forEachCsvRecord` in
   `@wellregarded/sources` — the same parser config the adapter's
   contract fixtures use), validates every row with the shared
   `validateCsvRow` (the same functions the wizard's preview endpoint
   uses), slices rows into batches of 100, and stores each batch as a
   content-addressed raw artifact (`{practiceId}/csv_import/{sha256}.json`)
   with the envelope `{ kind: "csv.import.batch", envelopeVersion,
   practiceId, draftId, batchIndex, firstRowNumber, headers, mapping,
   rows }` (schema in `packages/sources/src/csv/schema.ts`, mirroring the
   Google poller envelope from #125).
3. **record-chunk** — writes the batch keys onto the run
   (`import_runs.raw_artifact_keys`; dedupe's `conflict_reimport` path
   re-reads them, so this MUST land before any enqueue) and records the
   row-validation failures: each failed row counts toward `failed`, with
   up to 100 samples (`payloadRef: "row:<n>"`, 1-based data rows, header
   excluded — the same numbering as the preview and the report). Row
   errors never abort the import.
4. **enqueue-batches** — one `IngestMessage` (`sourceKind: "csv_import"`)
   per batch artifact onto `wr-ingest`. Idempotent by construction:
   content-addressed keys, deterministic per-row `sourceId`
   (`sha256(draftId + ":" + rowNumber)`), and the `(practice_id,
   source_kind, source_id)` unique constraint make re-enqueue after a
   resume safe (duplicates surface as `conflict_reimport` and land in
   dedupe's `skipped` tally).
5. **await drain** — polls `getImportRunSummary` every 30s
   (`step.sleep`; polls are engine-billed steps, so 30s not 1s) until
   `created + merged + skipped + failed >= totalRows`, capped at 240
   polls (2h). `>=` because re-deliveries can push dedupe counts past
   `totalRows`. A tripped cap appends a drain-timeout error sample
   (which also forces the terminal status to `completed_with_errors`).
6. **finalize** — `finalizeImportRun` (terminal status derived from
   counts: `failed` / `completed_with_errors` / `completed`), marks the
   draft `superseded` (a spent draft is never re-runnable; re-importing
   means a fresh upload → a new draft), audits `import.completed` with
   the counts summary.

The pipeline does the actual normalization: the registered
`csvImportAdapter` (`packages/sources/src/csv/adapter.ts`) applies the
envelope's embedded mapping via the shared row functions. Rows that fail
validation are skipped there deterministically — the Workflow already
accounted for them in step 3.

## Failure semantics

- A step that throws is retried by the engine with its default backoff;
  a `NonRetryableError` (from `@wellregarded/core`; the engine matches
  non-retryable errors by that name) aborts retries immediately —
  used for everything that can never succeed (missing/unconfirmed
  draft, invalid mapping, missing upload, header mismatch).
- If the run body fails past `validate`, a last-resort
  `record-workflow-failure` step appends the error to the run and
  finalizes it — **a run must never sit in `running` forever**. The
  draft stays `confirmed` so the import can be started again (the retry
  opens a new run and re-links the draft; the deterministic sourceIds
  make the second pass dedupe cleanly).
- Residual gap, on the record: if that last-resort step itself exhausts
  its retries (e.g. Postgres down for the whole retry window), the run
  does stay `running`. There is deliberately no auto-finalize timer in
  `import_runs` (#111); the report UI (#137) renders a staleness guard
  ("taking longer than expected" once a run is `running` past 3h —
  `IMPORT_RUN_STALE_AFTER_MS` in the dashboard) and a future sweeper can
  finalize orphans — noted here so that decision is not re-litigated
  from scratch.

## Triggering

**Production/preview** — #134's start endpoint calls
`env.CSV_IMPORT.create({ params: { importDraftId, practiceId,
requestId } })` after marking the draft `confirmed`. Manual re-runs work
through the same endpoint semantics (the draft must be `confirmed`).

The Wrangler CLI also works against deployed workflows:

```sh
npx wrangler workflows trigger wr-csv-import-preview \
  '{"importDraftId":"<uuid>","practiceId":"<uuid>"}'
npx wrangler workflows instances describe wr-csv-import-preview latest
```

**Local** — `wrangler dev` runs Workflows in Miniflare; the jobs worker
exposes the local-only debug route (hard-gated on
`ENVIRONMENT === "local"`):

```sh
pnpm --filter @wellregarded/jobs dev   # port 8789
curl -X POST http://localhost:8789/__local/trigger/csv-import \
  -d '{"importDraftId":"<uuid>","practiceId":"<uuid>"}'
# → {"triggered":"csv-import","instanceId":"..."}
```

Local caveat: the draft, the uploaded object (`RAW_IMPORTS`), and the
pipeline queues live in the api/pipeline workers' local simulators —
a fully local end-to-end run needs `pnpm dev` (all workers side by side)
so the buckets and queues are shared.

## Memory posture (the chunk step)

The chunk step is the one memory-critical step: it decodes the whole
object to a string (≤50MB by the upload cap, #133) and serializes each
batch envelope as it fills — parsed rows never accumulate beyond the
current batch, so the peak is roughly 2x the file size, comfortably
inside the 128MB isolate. papaparse runs in `step` mode (no result
array). If uploads ever outgrow the 50MB cap, this is the step to move
to a ranged/streamed parse.

## Test coverage (honest accounting)

- `packages/sources/src/csv/*.test.ts` (unit): the shared row-validation
  error matrix with exact plain-language messages, date-format
  application, `sourceId` determinism, and the adapter contract suite
  over the tricky-CSV matrix (BOM, quoted newlines, mixed date formats,
  semicolon delimiter, 10/100-point scales, empty optionals).
- `workers/jobs/src/csvImport.test.ts` (unit, Node): the orchestration
  against the checkpoint-memoizing fake step — step layout, drain loop
  and its 2h cap, failure finalization, resume without re-running
  completed steps.
- `workers/jobs/test/csvImport.integration.test.ts` (real Postgres,
  in-memory R2, the REAL pipeline dispatcher): a 350-row fixture → 4
  batch artifacts → 4 ingest messages → signals rows land through
  normalize (and dedupe with the fake embedder in the focused cases) →
  drain completes → report counts, error samples, draft linkage, audit
  entries all asserted; resume after a mid-enqueue failure duplicates
  nothing.
- **Not covered:** the real Workflows engine (retries, hibernation,
  replay) — same rationale and seam as the backfill (see
  embedding-backfill.md § "Test coverage"); the `CsvImport` class is
  thin wiring verified by typecheck and `wrangler deploy --dry-run`.
