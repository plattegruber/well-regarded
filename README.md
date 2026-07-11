# Well-Regarded

**The Patient Trust Platform** — for healthcare (initially dental) practices.

## What this is

Patient-experience signals are scattered: Google reviews, exports locked inside other reputation vendors, sticky notes from the front desk, and — eventually — direct post-visit feedback. Practices sit on a pile of genuine goodwill they cannot credibly show anyone, because none of it is normalized, none of it is verified, and none of it is *permissioned*. What they lack is not reputation; it is proof they are allowed to use.

Well-Regarded turns that scatter into an asset. Signals from any legitimate source are ingested and normalized into a canonical **Trust Signal**, then AI-classified (sentiment, urgency, response risk, publication suitability) — with every judgment stored as a **derivation**, separate from the immutable original. Concerns route into **recovery** workflows so problems get handled, not just counted. Positive evidence flows through **consent** management and is served — permissioned excerpt by permissioned excerpt — through a public proof API that practices embed on their own websites. **Trust Coverage** analysis then computes where a practice *lacks* credible evidence, by comparing what prospective patients search for against the proof the practice can actually show.

Two ethical invariants are structural, not aspirational. First, an AI inference is never presented as confirmed fact: every derivation row carries a `basis` (how we know) and a `confidence`, and the UI renders judgments as judgments. Second, nothing publishes without an explicit join through the `consents` table — there is no `is_publishable` boolean anywhere in the system, so a missing consent cannot be papered over by a flipped flag. See [docs/architecture.md](docs/architecture.md) for how these invariants are enforced in the schema.

## Quickstart

Requires Node 22 (see `.nvmrc`) and pnpm (pinned via the `packageManager` field; `corepack enable` will pick it up).

```sh
pnpm i          # install all workspace dependencies
pnpm dev        # run dev tasks via turbo (no workspace defines one yet)
pnpm build      # build all workspaces
pnpm test       # run every workspace's Vitest suite
pnpm lint       # biome check per workspace, via turbo
pnpm typecheck  # tsc --noEmit in every workspace, no build required
```

Biome replaces ESLint + Prettier; run `pnpm lint:fix` before pushing.

That is the whole flow today — the repo is a scaffold, so `pnpm dev` has nothing persistent to run yet. The one-command local environment (`pnpm setup` → `pnpm dev` bringing up dashboard, API, pipeline, and Postgres with pgvector via docker compose, plus the local port table) is coming in [#29](https://github.com/plattegruber/well-regarded/issues/29). Until it lands, `pnpm i && pnpm test && pnpm typecheck` is the verification loop.

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
| `infra/` | wrangler configs, environment matrix, deploy scripts — planned: [#28](https://github.com/plattegruber/well-regarded/issues/28) |
| `docs/` | Architecture doc, ADRs, runbooks |

## Learn more

- [CONTRIBUTING.md](CONTRIBUTING.md) — branch/PR conventions, test levels, issue workflow
- [docs/architecture.md](docs/architecture.md) — stack, data model spine, pipeline stages, ethical invariants
- [docs/adr/](docs/adr/) — architecture decision records
- [Roadmap (#164)](https://github.com/plattegruber/well-regarded/issues/164) — the master index of milestones and epics
