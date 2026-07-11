# Contributing

Start with the [README](README.md) for what the product is and how to get running, and [docs/architecture.md](docs/architecture.md) for the system map. This document covers the mechanics: branches, PRs, tests, and how work is tracked.

## Branches and pull requests

- Work happens on short-lived branches off `main`, named `<area>/<slug>` — e.g. `pipeline/dedupe-stage`, `db/consents-table`, `infra/biome-setup`.
- Every PR references its issue in the body: `Closes #N`.
- CI ([#39](https://github.com/plattegruber/well-regarded/issues/39), [#40](https://github.com/plattegruber/well-regarded/issues/40), [#55](https://github.com/plattegruber/well-regarded/issues/55)) runs five parallel checks on every PR — **lint**, **typecheck**, **test** (unit), **integration** (real Postgres service container), and **migration-check** (the Drizzle migration gate — see [Database migrations](#database-migrations)) — and all five must be green before merge.
- PRs are **squash-merged**. Keep the PR title in the imperative — it becomes the commit message on `main`.
- A PR template is coming with Epic [#2](https://github.com/plattegruber/well-regarded/issues/2) (CI/CD). Until it lands, the expectation it will encode: state what changed and why, link the issue, list how you verified it (which test levels you ran), and call out anything reviewers should look at closely.
- Keep PRs scoped to one issue. If you find adjacent work, file an issue rather than growing the diff.

## Tests

Four levels, from cheapest to most expensive. Two exist today (unit and integration); two are planned — do not be surprised when the commands for the planned ones fail.

| Level | Status | How to run |
|---|---|---|
| Unit | **exists** | `pnpm test` — Vitest, colocated `*.test.ts` files in every workspace; excludes `*.integration.test.ts`, needs no services |
| Integration | **exists** ([#40](https://github.com/plattegruber/well-regarded/issues/40)); local compose [#29](https://github.com/plattegruber/well-regarded/issues/29) and isolation harness [#49](https://github.com/plattegruber/well-regarded/issues/49) still planned | `docker compose up -d && pnpm db:migrate && pnpm test:integration` — Vitest against real local Postgres; file convention `*.integration.test.ts`; each test file will get an isolated schema or transaction rollback via the harness in `packages/db/test` once [#49](https://github.com/plattegruber/well-regarded/issues/49) lands |
| Worker | planned: [#113](https://github.com/plattegruber/well-regarded/issues/113) | `@cloudflare/vitest-pool-workers` for queue consumers and Hono routes (Miniflare under the hood) |
| E2E | planned: Epic [#25](https://github.com/plattegruber/well-regarded/issues/25) | Playwright against the seeded demo practice |

### Unit vs integration split

The two levels are separated by file glob, enforced by Vitest projects (see `packages/db/vitest.config.ts`):

- **`*.integration.test.ts`** ⇒ needs Postgres. Runs only under `pnpm test:integration` (uncached in turbo — a shared mutable database is not a cacheable input). Requires `DATABASE_URL`; the run **fails** when it is unset or the database is unreachable — integration tests never silently skip.
- **Anything else (`*.test.ts`)** ⇒ must run with no services. `pnpm test` never needs Docker or a network.

Locally: `pnpm run setup` (starts the compose Postgres and migrates — see the README Quickstart), then `pnpm test:integration` with `DATABASE_URL=postgres://wellregarded:wellregarded@localhost:54322/wellregarded`. In CI, the `integration` job spins up a health-checked `pgvector/pgvector:pg16` service container, applies migrations, and runs `pnpm test:integration` — in parallel with the unit `test` job, which stays service-free.

One rule this split imposes: unit tests may import DB code, but nothing may open a connection at module scope — construct clients inside tests/fixtures (connect lazily), or the unit project breaks for everyone.

Ground rules that hold at every level:

- Pure logic (consent checks, permission matrix, normalization) must be unit-testable without network or DB.
- No test may call a real external API. External services get local fakes (fake Google server, logging SMS/email adapters, fake `AppointmentEventSource`).
- AI prompts get golden-dataset eval fixtures in `packages/ai/evals`; classification changes run evals in CI (planned: [#73](https://github.com/plattegruber/well-regarded/issues/73)).

## Database migrations

Schema lives in `packages/db/src/schema`; migrations live in `packages/db/migrations` (see [packages/db/README.md](packages/db/README.md) for the full workflow). CI's `migration-check` job ([#55](https://github.com/plattegruber/well-regarded/issues/55)) gates every PR against the two ways migrations rot:

1. **Drift** — the schema changed but no migration was generated, so schema-as-code and the actual database silently diverge. CI re-runs `drizzle-kit generate` and fails if it produces anything. **Fix:** run `pnpm --filter @wellregarded/db db:generate` (or `pnpm db:generate` from the root) and commit the result — the generated SQL, the new `meta/*_snapshot.json`, and the `meta/_journal.json` update all belong in the PR.
2. **Editing history** — a `*.sql` migration that already exists on `main` was modified, deleted, or renamed. Drizzle records applied migrations by hash, so editing an applied file produces databases whose history depends on *when* they migrated. CI diffs `origin/main...HEAD` (merge-base, so new migrations arriving on `main` while your PR is open are never flagged) and fails on any modification. **Fix:** revert the edit and create a **new** migration with the change you wanted.

What "edited" means, precisely: the append-only rule covers only `*.sql` files under `packages/db/migrations/`. The `meta/_journal.json` and `meta/*_snapshot.json` files are legitimately rewritten by `generate` when a new migration is appended, so they are exempt from the append-only check — their integrity is enforced by the drift check instead (`generate` is deterministic given schema + journal, so a hand-edited journal or snapshot makes the regeneration diff non-empty). Adding brand-new migration files is always fine.

Rules that follow:

- **Migrations are append-only once merged, with no override** — there is no label or escape hatch that skips the gate. A truly broken merged migration is fixed by a **new corrective migration**, never by editing the old one.
- **Expand → migrate → contract** (the deploy discipline from [#44](https://github.com/plattegruber/well-regarded/issues/44)): migrations run before workers deploy, so every migration must be compatible with the *currently deployed* code. Add the new column/table first (expand), ship code that uses it, and only remove the old shape in a later migration once nothing depends on it (contract). Never drop or rename in the same PR that stops using the old shape.
- Use the pinned workspace `drizzle-kit` (via the pnpm scripts) — never a globally installed one; a version mismatch changes what `generate` emits and trips the drift check.

## Lint and format

Biome for both lint and format — no ESLint, no Prettier ([#27](https://github.com/plattegruber/well-regarded/issues/27)):

```sh
pnpm lint       # check (per workspace, via turbo)
pnpm lint:fix   # auto-fix + format
pnpm format     # format only
```

Run `pnpm lint:fix` before pushing. TypeScript compiler options live in the shared [`packages/tsconfig`](packages/tsconfig) package (`base.json`, `worker.json`, `react.json`) — every workspace extends one of those; do not add per-workspace strictness overrides.

## Issue workflow

All work is tracked as GitHub issues; [#164](https://github.com/plattegruber/well-regarded/issues/164) is the master roadmap.

- **Epics** carry the `epic` label and own milestones. They hold the invariants and context their children must respect.
- **Work items** are sub-issues of their epic, each with Context / Requirements / Implementation notes / Testing / Definition of done. [#26](https://github.com/plattegruber/well-regarded/issues/26) is the canonical example of the expected depth.
- If completing a task requires making an architectural decision, the issue is wrong — comment and fix the issue first (and record real decisions as [ADRs](docs/adr/)).
- **Anything bigger than ~3 days gets split** into smaller issues.

### Labels

| Label | When it applies |
|---|---|
| `epic` | Epic issues only — the parents that own milestones and sub-issues |
| `P0` / `P1` / `P2` | Priority within a milestone: P0 blocks other work, P1 is the default, P2 can slip |
| `type:feature` | Adds product behavior |
| `type:chore` | Tooling, config, refactors — no behavior change |
| `type:spike` | Timeboxed investigation; output is knowledge or a follow-up issue, not shipped code |
| `type:docs` | Documentation |
| `type:test` | Test infrastructure or coverage work |
| `area:*` | Which part of the system: `infra`, `ci`, `db`, `auth`, `dashboard`, `pipeline`, `ai`, `integrations`, `proof-api`, `patient-app`, `messaging`, `compliance`, `testing` |
| `blocked` | Cannot proceed until a stated dependency clears — say which in a comment |

### Picking work

1. Pick the earliest milestone with open issues; within it, `P0` before `P1` before `P2`.
2. Respect stated blockers: `Blocked by #N` (hard, same epic) or `Depends on Epic #N` (soft, cross-epic).
