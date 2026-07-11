# Secrets & environment variables

Every worker validates its string vars and secrets once per isolate via
`getEnv()` from `@wellregarded/core` (schemas live in
[`packages/core/src/env.ts`](../packages/core/src/env.ts) — that file is the
source of truth; keep each worker's `.dev.vars.example` in sync with it).
Cloudflare resource bindings (Queues, KV, R2, Hyperdrive, Durable Objects) are
runtime-injected objects typed by the `wrangler types`-generated `Env`
interface, **not** by zod — zod owns strings, `Env` owns bindings.

## Naming convention

- **SCREAMING_SNAKE_CASE** for every var name.
- Credentials carry a suffix identifying what they are: **`_KEY`**,
  **`_TOKEN`**, or **`_SECRET`**.
- Names are shared across workers where the value is shared — a var means the
  same thing everywhere it appears.

## Where values live

| Environment | Non-secret vars | Secrets |
| --- | --- | --- |
| Local (`wrangler dev`) | `.dev.vars` in the worker's directory (copy from `.dev.vars.example`) | `.dev.vars` (never committed) |
| Preview | `vars` in the worker's `wrangler.jsonc` | `wrangler secret put <NAME> --env preview` |
| Prod | `vars` in the worker's `wrangler.jsonc` | `wrangler secret put <NAME> --env prod` |

Run `wrangler secret put` from the worker's directory (e.g.
`workers/api`) so it targets that worker's config:

```sh
cd workers/api
wrangler secret put CLERK_SECRET_KEY --env preview
wrangler secret put CLERK_SECRET_KEY --env prod
```

Never commit a secret value: `.dev.vars` is gitignored, `.dev.vars.example`
files contain placeholder values only, and secrets never go in `vars` in
`wrangler.jsonc`.

## Known variables

| Name | Secret? | Needed by | Local source | Deployed source |
| --- | --- | --- | --- | --- |
| `ENVIRONMENT` | No | all workers (api, pipeline, jobs, dashboard, patient) | `.dev.vars` (`ENVIRONMENT=local`) | `vars` in each worker's `wrangler.jsonc` (`preview` \| `prod`) |
| `CLERK_SECRET_KEY` | **Yes** | api, dashboard | `workers/api/.dev.vars`, `apps/dashboard/.dev.vars` | `wrangler secret put CLERK_SECRET_KEY --env preview\|prod` |
| `CLERK_PUBLISHABLE_KEY` | No (publishable) | api, dashboard | `workers/api/.dev.vars`, `apps/dashboard/.dev.vars` | `vars` in `wrangler.jsonc` |
| `PII_ENCRYPTION_KEYS` | **Yes** | api, pipeline, jobs | each worker's `.dev.vars` (dev-only value in `.dev.vars.example`) | `wrangler secret put PII_ENCRYPTION_KEYS --env preview\|prod` |
| `PII_HASH_KEY` | **Yes** | api, pipeline, jobs | each worker's `.dev.vars` (dev-only value in `.dev.vars.example`) | `wrangler secret put PII_HASH_KEY --env preview\|prod` |

`CLERK_SECRET_KEY` / `CLERK_PUBLISHABLE_KEY` are **optional until Epic #4**
lands Clerk; the schemas in `packages/core/src/env.ts` flip them to required
then (`TODO(#4-auth-epic)`).

`PII_ENCRYPTION_KEYS` / `PII_HASH_KEY` are **optional until the PII
write/read paths land** (`TODO(#19/#20)` in the schemas). Format and
rotation rules: `PII_ENCRYPTION_KEYS` is JSON mapping key version to a
base64 32-byte AES-256 key (`{ "1": "<openssl rand -base64 32>" }`); the
highest version encrypts new writes, and old versions stay until no rows
remain encrypted with them. `PII_HASH_KEY` is a separate base64 32-byte
HMAC key — never rotate it casually; rotating orphans every stored
`value_hash`. Both are parsed into a `Keyring` by `keyringFromEnv` in
`packages/core/src/crypto/fieldEncryption.ts`.

Nothing DB-related appears here by design: workers reach Postgres through the
Hyperdrive **binding**, so there is no `DATABASE_URL` string var to validate.
(Locally, wrangler itself routes that binding to the docker compose Postgres
via `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` in each
binder's gitignored `.env` — wrangler *process* config, not a worker var, so
it lives in `.env`/`.env.example`, not `.dev.vars`. See
[`infra/environments.md`](../infra/environments.md).)

## Adding a new variable

1. Add it to the right schema(s) in `packages/core/src/env.ts` (compose shared
   fragments; don't repeat fields).
2. Add a row to the table above.
3. Add a placeholder line to each affected worker's `.dev.vars.example`.
4. Set the real value: `.dev.vars` locally, and `wrangler secret put <NAME>
   --env preview|prod` (or `vars` for non-secrets) in deployed environments.
