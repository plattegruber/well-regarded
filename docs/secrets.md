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
| `CLERK_JWKS_PUBLIC_KEY` | No (public key) | api | `workers/api/.dev.vars` | `wrangler secret put CLERK_JWKS_PUBLIC_KEY --env preview\|prod` (stored as a secret purely because the PEM is multiline — `vars` values are single-line) |
| `CLERK_AUTHORIZED_PARTIES` | No | api | `workers/api/.dev.vars` | `vars` in `wrangler.jsonc` |
| `CLERK_WEBHOOK_SIGNING_SECRET` | **Yes** | api | `workers/api/.dev.vars` | `wrangler secret put CLERK_WEBHOOK_SIGNING_SECRET --env preview\|prod` |
| `PII_ENCRYPTION_KEYS` | **Yes** | api, pipeline, jobs | each worker's `.dev.vars` (dev-only value in `.dev.vars.example`) | `wrangler secret put PII_ENCRYPTION_KEYS --env preview\|prod` |
| `PII_HASH_KEY` | **Yes** | api, pipeline, jobs | each worker's `.dev.vars` (dev-only value in `.dev.vars.example`) | `wrangler secret put PII_HASH_KEY --env preview\|prod` |
| `PATIENT_TOKEN_SECRET` | **Yes** | patient (verify); workers that mint links add it when those paths land | `apps/patient/.dev.vars` (dev-only value in `.dev.vars.example`) | `wrangler secret put PATIENT_TOKEN_SECRET --env preview\|prod` |
| `SESSION_SECRET` | **Yes** | dashboard (flash-message cookie session, #141) | `apps/dashboard/.dev.vars` (dev-only value in `.dev.vars.example`; the app falls back to an insecure dev secret when unset locally) | `wrangler secret put SESSION_SECRET --env preview\|prod` |
| `ANTHROPIC_API_KEY` | **Yes** | pipeline (classify stage, Epic #9); other AI callers add it when their paths land | `workers/pipeline/.dev.vars` (no dev value — leave unset until needed) | `wrangler secret put ANTHROPIC_API_KEY --env preview\|prod` |
| `PIPELINE_MODEL` | No | pipeline | `.dev.vars` (optional — defaults to `claude-haiku-4-5-20251001` in the schema) | `vars` in `wrangler.jsonc` (only to override the default) |
| `DRAFTING_MODEL` | No | pipeline | `.dev.vars` (optional — defaults to `claude-sonnet-5` in the schema) | `vars` in `wrangler.jsonc` (only to override the default) |

Every `CLERK_*` var is **optional in the schemas until the real Clerk
application exists** — see the next section for the exact flip.

`ANTHROPIC_API_KEY` is **optional in the schemas until the classify stage
(#67) goes live** (`TODO(#9-ai-epic)` in `packages/core/src/env.ts`) — no
live key exists yet. `PIPELINE_MODEL` / `DRAFTING_MODEL` route the logical
`"pipeline"` / `"drafting"` model lanes in `@wellregarded/ai` to concrete
model ids; the schema defaults are the source of truth, so the vars only
exist as an override knob (issue #63).

`CLERK_JWKS_PUBLIC_KEY` is the PEM public key the staff-auth middleware in
`workers/api` uses for **networkless** session-JWT verification (issue #68);
`CLERK_AUTHORIZED_PARTIES` is a comma-separated list of dashboard origins
checked against the token's `azp` claim; `CLERK_WEBHOOK_SIGNING_SECRET` is
the svix signing secret for `POST /webhooks/clerk` (issue #60 — see
[`docs/clerk-setup.md`](./clerk-setup.md)).

## Flipping on real Clerk keys

The Epic #4 auth code shipped before a real Clerk application existed, so
the schemas keep every `CLERK_*` var optional and the auth surfaces fail at
request time with a pointer here. When the Clerk app is provisioned:

1. In the Clerk dashboard, create (or use) the application; note the values:
   - **API keys** page → `CLERK_SECRET_KEY` (`sk_…`),
     `CLERK_PUBLISHABLE_KEY` (`pk_…`), and the **JWKS public key** (PEM,
     "JWT verification key") → `CLERK_JWKS_PUBLIC_KEY`.
   - **Webhooks** page → create the endpoint per
     [`docs/clerk-setup.md`](./clerk-setup.md) → signing secret (`whsec_…`)
     → `CLERK_WEBHOOK_SIGNING_SECRET`.
2. Local dev: put all of the above in `workers/api/.dev.vars` (and the
   dashboard's keys in `apps/dashboard/.dev.vars` when Epic #5 wires them).
3. Deployed: from `workers/api`, for each of `preview` and `prod`:

   ```sh
   wrangler secret put CLERK_SECRET_KEY --env preview
   wrangler secret put CLERK_JWKS_PUBLIC_KEY --env preview
   wrangler secret put CLERK_WEBHOOK_SIGNING_SECRET --env preview
   ```

   and add the non-secrets to `vars` in `wrangler.jsonc` (all three env
   stanzas!): `CLERK_PUBLISHABLE_KEY`, and `CLERK_AUTHORIZED_PARTIES` set to
   the dashboard origin(s) for that environment.
4. Flip the schemas: in `packages/core/src/env.ts` remove `.optional()` from
   the `CLERK_*` fields (the `TODO(#4-auth-epic)` markers), so a
   misconfigured deploy fails on first request with the full missing-var
   list instead of a 500 on the first authenticated route.

`PII_ENCRYPTION_KEYS` / `PII_HASH_KEY` are **optional until the PII
write/read paths land** (`TODO(#19/#20)` in the schemas). Format and
rotation rules: `PII_ENCRYPTION_KEYS` is JSON mapping key version to a
base64 32-byte AES-256 key (`{ "1": "<openssl rand -base64 32>" }`); the
highest version encrypts new writes, and old versions stay until no rows
remain encrypted with them. `PII_HASH_KEY` is a separate base64 32-byte
HMAC key — never rotate it casually; rotating orphans every stored
`value_hash`. Both are parsed into a `Keyring` by `keyringFromEnv` in
`packages/core/src/crypto/fieldEncryption.ts`.

`PATIENT_TOKEN_SECRET` signs the patient link tokens (issue #70) — the only
authentication `apps/patient` will ever have. Generate with `openssl rand
-base64 32` (base64 of at least 32 random bytes). **Optional until the
apps/patient link routes land** (`TODO(#21)` in the schema); structural
validation (base64, length) is owned by the key import in
`packages/core/src/patientTokens.ts`. Every worker that mints or verifies
patient tokens must share the same value.

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
