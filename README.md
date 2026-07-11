# Well-Regarded

[![CI](https://github.com/plattegruber/well-regarded/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/plattegruber/well-regarded/actions/workflows/ci.yml)

**The Patient Trust Platform** — for healthcare (initially dental) practices.

## What this is

Patient-experience signals are scattered: Google reviews, exports locked inside other reputation vendors, sticky notes from the front desk, and — eventually — direct post-visit feedback. Practices sit on a pile of genuine goodwill they cannot credibly show anyone, because none of it is normalized, none of it is verified, and none of it is *permissioned*. What they lack is not reputation; it is proof they are allowed to use.

Well-Regarded turns that scatter into an asset. Signals from any legitimate source are ingested and normalized into a canonical **Trust Signal**, then AI-classified (sentiment, urgency, response risk, publication suitability) — with every judgment stored as a **derivation**, separate from the immutable original. Concerns route into **recovery** workflows so problems get handled, not just counted. Positive evidence flows through **consent** management and is served — permissioned excerpt by permissioned excerpt — through a public proof API that practices embed on their own websites. **Trust Coverage** analysis then computes where a practice *lacks* credible evidence, by comparing what prospective patients search for against the proof the practice can actually show.

Two ethical invariants are structural, not aspirational. First, an AI inference is never presented as confirmed fact: every derivation row carries a `basis` (how we know) and a `confidence`, and the UI renders judgments as judgments. Second, nothing publishes without an explicit join through the `consents` table — there is no `is_publishable` boolean anywhere in the system, so a missing consent cannot be papered over by a flipped flag. See [docs/architecture.md](docs/architecture.md) for how these invariants are enforced in the schema.

## Quickstart

Prerequisites:

- **Node 22** — pinned in `.nvmrc` (`nvm use` picks it up).
- **pnpm** — pinned via the `packageManager` field; `corepack enable` makes `pnpm` resolve to the right version automatically.
- **Docker** (Desktop, or any daemon with compose v2) — runs the local Postgres.

```sh
pnpm i          # install all workspace dependencies
pnpm run setup  # copy example env files, start Postgres (docker compose), run migrations
pnpm dev        # boot every worker side by side (turbo terminal UI — one pane per worker)
```

> Note it's `pnpm run setup`, **not** bare `pnpm setup` — the bare form invokes
> pnpm's own built-in `setup` command (which configures `PNPM_HOME` and edits
> your shell rc) instead of the repo script. See Troubleshooting.

`pnpm run setup` is idempotent — run it whenever you pull new migrations. It never overwrites an existing `.dev.vars`. (Seeding a demo practice is part of the setup flow once [#32](https://github.com/plattegruber/well-regarded/issues/32) lands.)

After `pnpm dev` you have:

| Service | Where | Notes |
|---|---|---|
| Postgres 16 + pgvector | `localhost:54322` | `postgres://wellregarded:wellregarded@localhost:54322/wellregarded` (local-only credentials) |
| `workers/api` | <http://localhost:8787> | Hono API worker |
| `workers/pipeline` | <http://localhost:8788> | queue consumers (Miniflare-simulated queues) |
| `workers/jobs` | <http://localhost:8789> | cron/workflow entrypoints |
| `apps/patient` | <http://localhost:8790> | tokenized patient pages |
| `apps/dashboard` | <http://localhost:8791> | staff dashboard |

Ports are fixed in each workspace's `wrangler.jsonc` (inspector ports 9229–9233; full matrix in [`infra/environments.md`](infra/environments.md)). To run a subset, filter: `pnpm dev --filter @wellregarded/api --filter @wellregarded/pipeline`.

Everyday commands:

```sh
pnpm build      # build all workspaces
pnpm test       # run every workspace's Vitest suite
pnpm lint       # biome check per workspace, via turbo
pnpm typecheck  # tsc --noEmit in every workspace, no build required
```

Biome replaces ESLint + Prettier; run `pnpm lint:fix` before pushing.

## Troubleshooting

**`pnpm setup` printed pnpm-home instructions / edited my shell rc.** Bare `pnpm setup` is pnpm's built-in command for provisioning `PNPM_HOME` — it shadows the repo's `setup` script and appends a `# pnpm` block to your `~/.zshrc`/`~/.bashrc` (safe to delete). Use `pnpm run setup`.

**`pnpm run setup` fails with "The Docker daemon is not running".** The script checks `docker info` before touching compose. Start Docker Desktop (or your daemon), wait for it to finish booting, and re-run. If instead you see "Docker is not installed", install Docker Desktop first.

**Port 54322 already in use.** Something else grabbed our Postgres port. Find it with `lsof -i :54322`. If it's a stale `wellregarded-db-1` container from another checkout, `docker compose down` in that checkout (or `docker stop <id>`); otherwise stop the offender or change the port mapping locally in `docker-compose.yml` (and everywhere the canonical connection string appears).

**Schema looks wrong / migrations fail after a destructive schema change.** The named volume outlives `docker compose down`. Wipe and rebuild: `docker compose down -v && pnpm run setup`. (Migrations are append-only — see `packages/db/README.md` — so a healthy volume never needs this; it's for local experiments gone sideways.)

**`wrangler dev` fails with "address already in use" (8787–8791 or 9229–9233).** Each worker's port is fixed in its `wrangler.jsonc`. Usually the culprit is a previous `pnpm dev` that didn't fully exit — find it with `lsof -i :8787` (or whichever port) and kill the stale `workerd`/`wrangler` process.

**pnpm version mismatch / "This project is configured to use pnpm@…".** The repo pins pnpm via `packageManager`. Run `corepack enable` once so the pinned version is used automatically; if corepack itself is missing, install Node 22 (`nvm use`) which bundles it.

**`wrangler dev` errors about a local Postgres connection string for Hyperdrive, or DB queries fail.** Check Postgres is healthy (`docker compose ps` should say `healthy`) and that the worker's `.env` (not `.dev.vars` — wrangler ignores this var there) contains `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` with the canonical connection string — `pnpm run setup` creates it from `.env.example`. The suffix after `_STRING_` must exactly match the binding name (`HYPERDRIVE`); a mismatch fails silently.

## Repository layout

A pnpm + Turborepo monorepo. Workspaces live under `apps/*`, `workers/*`, and `packages/*`, all scoped `@wellregarded/*` and wired together with the `workspace:*` protocol. Most workspaces are placeholders today; the table below is the canonical map of what each one is *for*.

| Path | Purpose |
|---|---|
| `apps/dashboard` | React Router v7 staff dashboard (Clerk auth) — placeholder; RR7 scaffold is a separate issue |
| `apps/patient` | Tokenized patient pages: feedback, review invite, consent, opt-out (no Clerk, minimal deps) — placeholder |
| `workers/api` | Hono API worker: webhooks, integration callbacks, dashboard API, proof API |
| `workers/pipeline` | Queue consumers: normalize → dedupe → classify → route — placeholder |
| `workers/jobs` | Cloudflare Workflows + cron entrypoints — placeholder |
| `packages/db` | Drizzle schema, migrations, query helpers, test factories — placeholder |
| `packages/core` | Domain types, zod schemas, permission matrix, consent logic, env validation |
| `packages/ai` | Claude client wrapper, prompts, structured-output schemas, model routing, eval harness — placeholder |
| `packages/sources` | `SourceAdapter` implementations: google, csv, manual, opendental, firstparty — placeholder |
| `packages/tsconfig` | Shared strict TypeScript config (`base.json`, `worker.json`, `react.json`) that every workspace extends |
| `infra/` | environment matrix ([`infra/environments.md`](infra/environments.md)); per-worker `wrangler.jsonc` files live in each workspace |
| `docs/` | Architecture doc, ADRs, runbooks |

## Learn more

- [CONTRIBUTING.md](CONTRIBUTING.md) — branch/PR conventions, test levels, issue workflow
- [docs/architecture.md](docs/architecture.md) — stack, data model spine, pipeline stages, ethical invariants
- [docs/adr/](docs/adr/) — architecture decision records
- [Roadmap (#164)](https://github.com/plattegruber/well-regarded/issues/164) — the master index of milestones and epics
