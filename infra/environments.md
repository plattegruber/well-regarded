# Environment matrix

Every deployable workspace ships as a Cloudflare Worker configured by a
`wrangler.jsonc` in its workspace root. Naming convention everywhere:
`wr-<name>-<env>` with `<name>` ∈ {`api`, `pipeline`, `jobs`, `patient`,
`dashboard`} and `<env>` ∈ {`local`, `preview`, `prod`}.

- **local** — the top-level (default) config in each `wrangler.jsonc`. Used by
  `wrangler dev` only; never deployed. Queues, KV, R2, and Durable Objects run
  in Miniflare's local simulators, so **zero Cloudflare resources are needed**.
- **preview** — `wrangler deploy --env preview`.
- **prod** — `wrangler deploy --env prod`.

> **Gotcha:** wrangler environments do **not** inherit bindings. Each binding
> is repeated in full in the top-level (local) block and in `env.preview` /
> `env.prod` of every `wrangler.jsonc`. Edit all three when changing anything.

Binding **names** (the identifiers code sees on `env.*`) are API surface and
are documented in [`docs/architecture-bindings.md`](../docs/architecture-bindings.md).

## Worker names

| Workspace           | local (dev only)      | preview                 | prod                 |
| ------------------- | --------------------- | ----------------------- | -------------------- |
| `workers/api`       | `wr-api-local`        | `wr-api-preview`        | `wr-api-prod`        |
| `workers/pipeline`  | `wr-pipeline-local`   | `wr-pipeline-preview`   | `wr-pipeline-prod`   |
| `workers/jobs`      | `wr-jobs-local`       | `wr-jobs-preview`       | `wr-jobs-prod`       |
| `apps/patient`      | `wr-patient-local`    | `wr-patient-preview`    | `wr-patient-prod`    |
| `apps/dashboard`    | `wr-dashboard-local`  | `wr-dashboard-preview`  | `wr-dashboard-prod`  |

## Queues

Producers/consumers per worker are listed in the bindings doc; this table maps
queue names per environment. Local names are unsuffixed — they exist only
inside Miniflare, so they can never collide with a cloud environment. Preview
and prod names are environment-suffixed so environments never share a queue.

| Queue (local / Miniflare) | preview               | prod               | Provisioned?     |
| ------------------------- | --------------------- | ------------------ | ---------------- |
| `wr-ingest`               | `wr-ingest-preview`   | `wr-ingest-prod`   | **TBD, Epic #2** |
| `wr-dedupe`               | `wr-dedupe-preview`   | `wr-dedupe-prod`   | **TBD, Epic #2** |
| `wr-classify`             | `wr-classify-preview` | `wr-classify-prod` | **TBD, Epic #2** |
| `wr-route`                | `wr-route-preview`    | `wr-route-prod`    | **TBD, Epic #2** |

Every pipeline consumer has a dead-letter queue (`max_retries: 3`):

| DLQ (local / Miniflare) | preview                   | prod                   | Provisioned?     |
| ----------------------- | ------------------------- | ---------------------- | ---------------- |
| `wr-ingest-dlq`         | `wr-ingest-dlq-preview`   | `wr-ingest-dlq-prod`   | **TBD, Epic #2** |
| `wr-dedupe-dlq`         | `wr-dedupe-dlq-preview`   | `wr-dedupe-dlq-prod`   | **TBD, Epic #2** |
| `wr-classify-dlq`       | `wr-classify-dlq-preview` | `wr-classify-dlq-prod` | **TBD, Epic #2** |
| `wr-route-dlq`          | `wr-route-dlq-preview`    | `wr-route-dlq-prod`    | **TBD, Epic #2** |

## KV / R2 / Hyperdrive / Durable Objects

| Resource                    | Workers using it                 | local                                        | preview                    | prod                    | Provisioned?     |
| --------------------------- | -------------------------------- | -------------------------------------------- | -------------------------- | ----------------------- | ---------------- |
| KV namespace (`PROOF_CACHE`) | api                             | Miniflare simulator (id ignored)             | `wr-proof-cache-preview`   | `wr-proof-cache-prod`   | **TBD, Epic #2** |
| R2 bucket (`RAW_IMPORTS`)   | api                              | `wr-raw-imports-local` (Miniflare simulator) | `wr-raw-imports-preview`   | `wr-raw-imports-prod`   | **TBD, Epic #2** |
| R2 bucket (`RAW_ARTIFACTS`) | pipeline                         | `wr-raw-artifacts-local` (Miniflare simulator) | `wr-raw-artifacts-preview` | `wr-raw-artifacts-prod` | **TBD, Epic #2** |
| Hyperdrive (`HYPERDRIVE`)   | api, jobs, dashboard, pipeline   | env var, see below                           | `wr-hyperdrive-preview`    | `wr-hyperdrive-prod`    | **TBD, Epic #2** |
| Durable Object (`SYNC_LOCK`) | jobs                            | Miniflare simulator                          | `SyncLock` class, same worker | `SyncLock` class, same worker | n/a (code-backed) |
| Workers AI (`AI`)           | pipeline, jobs                   | **no simulator** — proxies to the real API (needs a logged-in wrangler; incurs usage) | account-level, no id       | account-level, no id    | n/a (account-level) |
| Workflow (`EMBEDDING_BACKFILL`) | jobs                         | `wr-embedding-backfill-local` (Miniflare)     | `wr-embedding-backfill-preview` | `wr-embedding-backfill-prod` | n/a (code-backed, `EmbeddingBackfill` class) |

**Nothing is provisioned yet.** All KV namespace ids and Hyperdrive config ids
in the `wrangler.jsonc` files are the placeholder `TBD-provision-in-epic-2`;
the deploy-workflow issue in Epic #2 provisions the real resources and fills
them in. `wrangler deploy --dry-run --env preview|prod` parses every config
(dry-run does not validate ids against Cloudflare), but a **real**
`wrangler deploy` will fail on those placeholder ids until Epic #2 fills them
in — that is expected. `wrangler dev` needs none of it.

## External API secrets

Secrets are set per worker per environment with `wrangler secret put` (never
in `vars`); the full variable table and naming rules live in
[`docs/secrets.md`](../docs/secrets.md).

| Secret | Workers using it | local | preview | prod | Provisioned? |
| --- | --- | --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | pipeline (classify stage, Epic #9) | `workers/pipeline/.dev.vars` (unset until needed) | `wrangler secret put ANTHROPIC_API_KEY --env preview` | `wrangler secret put ANTHROPIC_API_KEY --env prod` | **TBD, Epic #9 — no live key exists yet** (env schema keeps it optional, issue #63) |

Model routing (`PIPELINE_MODEL` / `DRAFTING_MODEL`) is **not** a secret: the
defaults live in `packages/core/src/env.ts` and the vars only exist to
override them per environment via `vars` in `wrangler.jsonc`.

### Hyperdrive local development

Hyperdrive has no Miniflare simulator; locally, wrangler connects the
`HYPERDRIVE` binding straight to a Postgres connection string taken from:

```
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://wellregarded:wellregarded@localhost:54322/wellregarded
```

(The suffix after `..._STRING_` is the binding name; that value is the
canonical docker compose connection string. The older
`WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` spelling also works
but wrangler 4.110+ warns it is deprecated.)

Wrangler reads this from its **process environment or the worker's `.env`
file** — *not* from `.dev.vars` (`.dev.vars` entries become worker runtime
vars; wrangler silently ignores Hyperdrive connection strings there —
verified on wrangler 4.110). Each Hyperdrive binder (api, jobs, dashboard)
commits a `.env.example` with this line; `pnpm run setup` copies it to the
gitignored `.env`. `wrangler dev` for api/jobs/dashboard refuses to boot
without it; pipeline and patient have no Hyperdrive binding and boot without
it.

## Cron triggers

| Worker         | Schedule (all envs)          | Status                                        |
| -------------- | ---------------------------- | --------------------------------------------- |
| `workers/jobs` | `0 6 * * *`                  | Placeholder proving cron config parses; real schedules land in Epic #20 |

## Local dev ports

Fixed in each `wrangler.jsonc` so `pnpm dev` can run everything side by side:

| Worker    | port | inspector_port |
| --------- | ---- | -------------- |
| api       | 8787 | 9229           |
| pipeline  | 8788 | 9230           |
| jobs      | 8789 | 9231           |
| patient   | 8790 | 9232           |
| dashboard | 8791 | 9233           |

The dashboard is a React Router v7 app whose dev server is Vite
(`@cloudflare/vite-plugin` running workerd inside it), so its port is pinned
in `apps/dashboard/vite.config.ts` (`server.port`) as well as in the
`dev` block of its `wrangler.jsonc` (which only covers a raw `wrangler dev`).
Keep the two in sync when changing the matrix.

### Deploying the dashboard (React Router v7)

Unlike the plain workers, the dashboard must be **built before deploying**:
`react-router build` resolves `wrangler.jsonc` — honoring `$CLOUDFLARE_ENV`
for environment selection — into `build/server/wrangler.json` and drops a
redirect in `.wrangler/deploy/config.json` that `wrangler deploy` follows.
Select the environment at build time (`CLOUDFLARE_ENV=preview pnpm build`),
not with `--env` at deploy time; the built config is already flattened to a
single environment.
