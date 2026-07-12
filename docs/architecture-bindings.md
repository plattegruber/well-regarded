# Bindings

Every platform binding a Well Regarded worker sees on its `env` object.
Binding **names are API surface**: renaming one touches code in every worker
that uses it, so they are settled here (issue #28) before any consuming code
exists. Resource names/ids behind the bindings, and which are provisioned vs
TBD, live in [`infra/environments.md`](../infra/environments.md).

| Binding          | Type            | Workers                    | Purpose                                                                                         |
| ---------------- | --------------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| `ENVIRONMENT`    | var (string)    | all five                   | `"local"` \| `"preview"` \| `"prod"` — lets code branch on environment without sniffing hostnames |
| `INGEST_QUEUE`   | queue producer  | api, jobs                  | Enqueue raw review/mention payloads at the top of the pipeline spine (`wr-ingest`)              |
| `DEDUPE_QUEUE`   | queue producer  | pipeline                   | Normalize stage (consumer of `wr-ingest`) feeds the dedupe stage (`wr-dedupe`)                  |
| `CLASSIFY_QUEUE` | queue producer  | pipeline                   | Dedupe stage feeds the classify stage (`wr-classify`)                                           |
| `ROUTE_QUEUE`    | queue producer  | pipeline                   | Classify stage feeds the route stage (`wr-route`, terminal)                                     |
| `INGEST_DLQ`     | queue producer  | pipeline                   | Dead-letter forward path for the ingest stage (`wr-ingest-dlq`): malformed / non-retryable messages (#98) |
| `DEDUPE_DLQ`     | queue producer  | pipeline                   | Dead-letter forward path for the dedupe stage (`wr-dedupe-dlq`)                                 |
| `CLASSIFY_DLQ`   | queue producer  | pipeline                   | Dead-letter forward path for the classify stage (`wr-classify-dlq`)                             |
| `ROUTE_DLQ`      | queue producer  | pipeline                   | Dead-letter forward path for the route stage (`wr-route-dlq`)                                   |
| `PROOF_CACHE`    | KV namespace    | api                        | Cache of rendered social-proof payloads served by the API                                       |
| `OAUTH_STATE`    | KV namespace    | api                        | Single-use OAuth state/PKCE-verifier records for the Google connect flow (#118): `{ verifier, practiceId, staffId }` under the state nonce, 10-minute TTL, deleted on callback read (`wr-oauth-state-<env>`) |
| `RAW_IMPORTS`    | R2 bucket       | api, jobs, dashboard       | Raw uploaded/imported source files (`wr-raw-imports-<env>`): api writes uploads (#133), the CSV import Workflow reads them (#135), and the dashboard's mapping wizard (#134) reads back the 256KB preview window in its loaders |
| `RAW_ARTIFACTS`  | R2 bucket       | pipeline, jobs, api, dashboard | Immutable content-addressed raw source artifacts (#100), read by the normalize stage; the CSV import Workflow (#135) writes batch envelopes and the GBP poller (#123) review-page envelopes here BEFORE enqueueing — store-before-enqueue (`wr-raw-artifacts-<env>`). The api worker writes manual-entry payloads (#138) and reads batch envelopes for the failures CSV (#137); the dashboard's import report (#137) reads them to show failed rows' original values |
| `HYPERDRIVE`     | Hyperdrive      | api, jobs, dashboard, pipeline | Pooled connection to the Postgres database (pgvector)                                       |
| `SYNC_LOCK`      | Durable Object  | jobs, api (cross-script)   | Per-connection lock + runner serializing GBP review syncs (#123): class `SyncLock` (SQLite-backed) lives in jobs; api binds it cross-script (`script_name: wr-jobs-<env>`) for the manual "Sync now" endpoint |
| `AI`             | Workers AI      | pipeline (preview/prod only), jobs | bge-m3 embeddings (#71): inline in the classify stage and the dedupe fuzzy path (pipeline), and in the backfill Workflow (jobs). No local simulator — the binding always proxies to the real API, so pipeline's local block omits it (the workerd unit-test pool boots from that block and CI has no Cloudflare credentials); code treats it as optional and degrades to NULL embeddings, swept by the backfill |
| `EMBEDDING_BACKFILL` | Workflow    | jobs                       | The `wr-embedding-backfill-<env>` Workflow (class `EmbeddingBackfill`, #71): batched, resumable re-embedding of `proof_excerpts` rows whose vector is NULL or from a different model — see [embedding-backfill.md](embedding-backfill.md) |
| `CSV_IMPORT`     | Workflow        | jobs, api, dashboard       | The `wr-csv-import-<env>` Workflow (class `CsvImport`, #135): durable CSV import — validate, batch, enqueue, await drain, finalize — see [csv-import.md](csv-import.md). Defined in jobs; api's start endpoint and the dashboard wizard's confirm action (#134) bind it cross-script (optional at runtime — a missing binding confirms the draft and logs, never fails the request) |
| `REPLY_IMPORT_BACKFILL` | Workflow | jobs                       | The `wr-reply-import-backfill-<env>` Workflow (class `ReplyImportBackfill`, #214): batched, resumable re-read of stored GBP review-page artifacts that persists pre-existing owner replies as imported `responses` rows (`origin = 'source_import'`, born `published`) for signals ingested before the normalize-stage reply seam existed |

Queue **consumers** (not bindings, but part of the same contract) all live in
`workers/pipeline`: `wr-ingest`, `wr-dedupe`, `wr-classify`, `wr-route`, each
with `max_retries: 3` and a `wr-<stage>-dlq` dead-letter queue — plus the four
DLQs themselves, whose consumer persists failures and acks unconditionally
(#98).

Local-only exception: the pipeline worker's top-level (local) `wrangler.jsonc`
block additionally binds `INGEST_QUEUE` so the `POST /__local/enqueue/<stage>`
debug endpoint can feed the spine's front door under `wrangler dev`. It is
deliberately absent from `env.preview`/`env.prod` — deployed producers to
`wr-ingest` are api and jobs only.

`apps/patient` intentionally has no bindings beyond `ENVIRONMENT` (minimal
deps mandate).

> Maintained as a standalone file because `docs/architecture.md` is authored
> in issue #34; that doc links here rather than duplicating this table.
