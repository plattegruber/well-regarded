#!/usr/bin/env bash
# One-command local environment (canonical flow per roadmap #164:
# `pnpm run setup && pnpm dev`). Invoke via `pnpm run setup` — bare
# `pnpm setup` is shadowed by pnpm's built-in PNPM_HOME provisioning command.
#
# Idempotent by design — safe to run any number of times:
#   1. copies each .dev.vars.example -> .dev.vars where missing (never overwrites),
#   2. starts the docker compose Postgres and waits for its healthcheck,
#   3. applies database migrations (re-running is a no-op),
#   4. seeds the demo practice (#32; wipe-and-recreate, scoped to the demo
#      practice only, so re-running always converges on the same dataset).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Canonical local connection string — must match docker-compose.yml and every
# .dev.vars.example verbatim.
LOCAL_DATABASE_URL="postgres://wellregarded:wellregarded@localhost:54322/wellregarded"

info() { printf '\033[1;34m[setup]\033[0m %s\n' "$1"; }
fail() {
  printf '\033[1;31m[setup] error:\033[0m %s\n' "$1" >&2
  exit 1
}

# --- 1. Local env files --------------------------------------------------------
# .dev.vars      -> worker runtime vars/secrets (all five deployables)
# .env           -> wrangler process config, i.e. the local Hyperdrive->Postgres
#                   connection string (only the workers that bind HYPERDRIVE)
info "Copying example env files where missing (existing files are never touched)..."
copy_if_missing() {
  local example="$1" target="$2"
  [ -f "$example" ] || fail "expected $example to exist — was it deleted?"
  if [ -f "$target" ]; then
    info "  $target already exists — leaving it alone"
  else
    cp "$example" "$target"
    info "  created $target"
  fi
}
for dir in workers/api workers/pipeline workers/jobs apps/dashboard apps/patient; do
  copy_if_missing "$dir/.dev.vars.example" "$dir/.dev.vars"
done
# Hyperdrive binders (see infra/environments.md).
for dir in workers/api workers/jobs apps/dashboard; do
  copy_if_missing "$dir/.env.example" "$dir/.env"
done

# --- 2. Postgres via docker compose -------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  fail "Docker is not installed (the \`docker\` command was not found).
        Local dev needs Docker to run Postgres. Install Docker Desktop
        (https://docs.docker.com/get-docker/), then re-run \`pnpm run setup\`."
fi

if ! docker info >/dev/null 2>&1; then
  fail "The Docker daemon is not running (\`docker info\` failed).
        Start Docker Desktop (or your Docker daemon) and wait for it to finish
        starting, then re-run \`pnpm run setup\`."
fi

info "Starting Postgres (docker compose up -d --wait; blocks until the healthcheck passes)..."
# --wait exits non-zero if the healthcheck never passes — exactly what we want.
docker compose up -d --wait

# --- 3. Migrations -------------------------------------------------------------
info "Applying database migrations..."
DATABASE_URL="$LOCAL_DATABASE_URL" pnpm --filter @wellregarded/db db:migrate

# --- 4. Seed -------------------------------------------------------------------
# Wipe-and-recreate the demo practice (Cedar Ridge Dental) — idempotent and
# scoped to the demo practice only; it never touches other data (#32).
info "Seeding the demo practice (Cedar Ridge Dental)..."
DATABASE_URL="$LOCAL_DATABASE_URL" pnpm --filter @wellregarded/db seed

info "Done. Run \`pnpm dev\` to boot the local workers (ports: see README Quickstart)."
