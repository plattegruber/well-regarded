# @wellregarded/api

The Hono API worker. Route-grouping and middleware conventions live in
`src/app.ts` — read the block comment there before adding a route.

## Auth surfaces

Three auth surfaces (Epic #4), one per route group. A route group mounts
exactly one auth middleware; nothing may ever accept two credential types.

| Surface | Credential | Route group | Middleware | Context |
| --- | --- | --- | --- | --- |
| Staff | Clerk session JWT (`Authorization: Bearer` or `__session` cookie) | `/api/*` | `staffAuth()` | `c.get("actor")` — `StaffActor` |
| Proof API | Publishable API key (`pk_live_…` / `pk_test_…`) | `/proof/*` | `apiKeyAuth()` | `c.get("apiActor")` — `ApiKeyActor` |
| Patients | Signed link tokens (`@wellregarded/core` `patientTokens.ts`) | `apps/patient` (Epic #21), not this worker | — | — |

Webhooks (`/webhooks/*`) are outside all three: their only auth is the
provider's signature (svix for Clerk).

### API key auth (issue #81)

Publishable, practice-scoped keys for the Proof API (Epic #14), prefixed
`pk_live_` / `pk_test_`. They are client-visible by design (script-tag
embeds on practice websites) but still show-once: the plaintext exists only
in the create-response; the `api_keys` table stores a SHA-256 hash and a
`last4` display hint. Keys live in the database, not in env vars.

- **Presenting a key:** `Authorization: Bearer pk_…` preferred; `?key=pk_…`
  works as a fallback for embeds that can't set headers (query strings end
  up in logs — acceptable for a publishable key, still second choice).
- **Failure mode:** unknown, revoked, malformed, or missing keys are all
  `401 { "error": "invalid_api_key" }` — the response never distinguishes
  them.
- **Revocation** (`POST /api/api-keys/:id/revoke`) is immediate: lookups
  are uncached, so the next request misses. Keys are never deleted.
- **Management** (`GET`/`POST /api/api-keys`, `POST …/:id/revoke`) sits
  under staff auth, gated by `requirePermission("manage_api_keys")`
  (matrix: owner only) and audited (`api_key.created` / `api_key.revoked`).
  The Settings UI ships with Epic #14.
- `apiActor.keyId` is the future rate-limit bucket (Epic #22);
  `apiActor.environment === "test"` flags demo/staging scoping for later
  proof routes.

## Testing

```sh
pnpm --filter @wellregarded/api test              # unit (no DB)
docker compose up -d && pnpm db:migrate
pnpm --filter @wellregarded/api test:integration  # real Postgres
```
