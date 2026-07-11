# Embedding backfill (`wr-embedding-backfill`)

The resumable Cloudflare Workflow in `workers/jobs` that fills
`proof_excerpts.embedding` for every row the inline pass missed
([#71](https://github.com/plattegruber/well-regarded/issues/71), Epic #9).
It is this repo's **first real Workflow**, so it also establishes the
pattern — read `workers/jobs/src/embeddingBackfill.workflow.ts` before
writing the next one.

## What it does

Selects `proof_excerpts` rows where `embedding IS NULL OR embedding_model
!= <target>` (optionally practice-scoped), embeds them with Workers AI
`@cf/baai/bge-m3` (1024 dims) in batches of 50, and writes each vector
back together with `embedding_model`. Because the WHERE clause excludes
rows that are already current, re-running it is always safe; the same
clause is the future model-migration hook (change the target model and the
whole corpus matches again — no re-embed tooling exists yet on purpose).

Rows normally get their embedding **inline** in the pipeline's classify
stage; the backfill exists for the leftovers: embedding failures (rate
limits, outages), environments without the `AI` binding, and historical
rows from before the extraction pass existed (the demo seed's excerpts,
deliberately NULL).

## Parameters

`POST`ed as the Workflow instance's params (all optional):

| param | default | meaning |
|---|---|---|
| `practiceId` | null (global) | scope the sweep to one practice |
| `batchSize` | 50 | rows per batch = rows per Workers AI call = one Workflow step |
| `sleepMs` | 2000 | `step.sleep` between batches — Workers AI has per-account rate limits; the backfill must degrade to slower, never fail |

## Triggering

**Deployed** (preview/prod) — the Wrangler CLI, against the env-suffixed
workflow name:

```sh
npx wrangler workflows trigger wr-embedding-backfill-preview '{"practiceId":null}'
npx wrangler workflows instances describe wr-embedding-backfill-preview latest
```

**Local** — `wrangler dev` runs Workflows in Miniflare, but the CLI
trigger only talks to deployed workflows, so the jobs worker exposes a
local-only debug route (hard-gated on `ENVIRONMENT === "local"`, mirroring
the pipeline's `/__local/enqueue/<stage>`):

```sh
pnpm --filter @wellregarded/jobs dev   # port 8789
curl -X POST http://localhost:8789/__local/trigger/embedding-backfill \
  -d '{"batchSize":10,"sleepMs":100}'
# → {"triggered":"embedding-backfill","instanceId":"..."}
```

Caveat for a fully local run: there is **no local Workers AI simulator** —
the `AI` binding under `wrangler dev` proxies to the real Workers AI API
(needs a logged-in wrangler + account, and incurs real usage). Without
that, the instance fails fast with the missing-binding error. No cron: the
backfill is manual-trigger-only for M1.

## The Workflow pattern (established here)

- **Entrypoint class is paper-thin and quarantined.** The class extends
  `WorkflowEntrypoint` from `cloudflare:workers`, which cannot resolve
  under plain Node — so it lives in its own `*.workflow.ts` module,
  imported ONLY from `src/worker.ts` (same rule as Durable Objects). All
  logic lives in `src/embeddingBackfill.ts`, plain-Node testable.
- **One `step.do` per batch = one durable checkpoint.** The engine
  persists each completed step's return value; after eviction/failure it
  replays completed steps from storage (callbacks do NOT re-run) and
  resumes at the first unfinished one. Step names are deterministic
  (`embed-batch-<n>`) because the checkpoint cache is keyed by name.
- **Step returns are plain JSON** (`BackfillBatchResult`) — that's what
  the engine can persist.
- **Nothing stateful outlives a step.** Each batch opens its own Postgres
  connection inside its `step.do` and closes it before returning; the
  instance may sleep for minutes and resume in a different isolate.
- **Rate-awareness via `step.sleep`**, never busy-waiting or failing.
- **Config**: the `workflows` block in `wrangler.jsonc` is per-env like
  every other binding (names `wr-embedding-backfill-<env>`), NOT inherited.

## Test coverage (honest accounting)

- `workers/jobs/src/embeddingBackfill.test.ts` (unit, Node): the
  orchestration loop against a fake step that memoizes completed steps the
  way the engine's checkpoints do — cursor threading, rate-pause between
  batches, and resume-after-failure without re-running completed batches.
- `workers/jobs/test/embeddingBackfill.integration.test.ts` (real
  Postgres, fake embedder): seeded NULL rows get embedded +
  `embedding_model` stamped; re-run is a no-op; a paraphrase-style query
  vector finds the excerpt via `hybridSearch`; mid-run failure resumes
  without re-embedding batch 0; the different-target-model re-embed hook.
- **Not covered:** the real Workflows engine (retry policies, hibernation,
  replay) and the real bge-m3 output. `@cloudflare/vitest-pool-workers`
  has introspection support for Workflows, but the engine-behavior tests
  would assert Cloudflare's semantics, not ours — the seam we rely on
  (deterministic step names + serializable returns + WHERE-clause
  idempotency) is exactly what the fake step exercises. The
  `EmbeddingBackfill` class itself is thin wiring, verified by typecheck
  and by `wrangler deploy --dry-run`; first-run verification against the
  real engine happens in preview when Epic #2 provisions the bindings.
