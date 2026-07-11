# well-regarded

## Repository layout

A pnpm + Turborepo monorepo. Workspaces live under `apps/*`, `workers/*`, and `packages/*`, all scoped `@wellregarded/*` and wired together with the `workspace:*` protocol.

- `apps/dashboard` — staff-facing dashboard app (placeholder; React Router v7 scaffold is a separate issue).
- `apps/patient` — patient-facing app (placeholder).
- `workers/api` — API worker; demonstrates the cross-package import from `@wellregarded/core`.
- `workers/pipeline` — data pipeline worker (placeholder).
- `workers/jobs` — background jobs worker (placeholder).
- `packages/db` — database layer shared package (placeholder).
- `packages/core` — core shared domain logic (placeholder).
- `packages/ai` — AI helpers shared package (placeholder).
- `packages/sources` — external data source integrations (placeholder).

## Development

Requires Node 22 (see `.nvmrc`) and pnpm (pinned via the `packageManager` field; `corepack enable` will pick it up).

```sh
pnpm i          # install all workspace dependencies
pnpm dev        # run dev tasks via turbo (no workspace defines one yet)
pnpm build      # build all workspaces
pnpm test       # run every workspace's Vitest suite
pnpm lint       # lint pipeline (placeholder until Biome lands)
pnpm typecheck  # tsc --noEmit in every workspace, no build required
```
