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
| `RAW_IMPORTS`    | R2 bucket       | api                        | Raw uploaded/imported source files (`wr-raw-imports-<env>`)                                     |
| `RAW_ARTIFACTS`  | R2 bucket       | pipeline                   | Immutable content-addressed raw source artifacts (#100), read by the normalize stage (`wr-raw-artifacts-<env>`) |
| `HYPERDRIVE`     | Hyperdrive      | api, jobs, dashboard, pipeline | Pooled connection to the Postgres database (pgvector)                                       |
| `SYNC_LOCK`      | Durable Object  | jobs                       | Per-practice lock serializing Open Dental sync runs (class `SyncLock`, SQLite-backed; stub until Epic #20) |

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
