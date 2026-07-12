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

## CSV imports (issue #133)

`POST /api/imports/csv` (staff auth, `manage_settings`) accepts a CSV as
the RAW request body (`Content-Type: text/csv`, not multipart) up to
**50MB**, stores it content-addressed in the `RAW_IMPORTS` R2 bucket
(`{practiceId}/imports/{sha256}.csv` — the raw-artifact key scheme from
`@wellregarded/sources`), creates an `import_drafts` row, and returns
`{ importDraftId, headers, previewRows, detected }`.
`PUT /api/imports/csv/:draftId/mapping` validates and persists the
wizard's `ColumnMapping` (`@wellregarded/core`). Both are audited.

Size cap and memory, honestly stated:

- **One plain request is enough.** Cloudflare's per-request body limit is
  100MB on Free/Pro (200MB Business, 500MB Enterprise), so the 50MB cap
  needs no chunked/multipart protocol on any plan. The cap is enforced by
  the `Content-Length` header (413 before reading) AND a streamed byte
  counter that aborts mid-body — a lying client cannot make the worker
  buffer past it.
- **The upload is buffered once, as bytes** (single `Uint8Array`, never a
  string): the content-addressed key needs the full-body sha-256 before
  the R2 key exists, and 50MB of bytes sits comfortably in the 128MB
  isolate. Rationale in `src/routes/imports.ts`.
- **The preview never re-reads the whole object**: a 256KB ranged R2 get,
  decoded and fed to papaparse with a hard `preview` record budget (~52),
  BOM-stripped, dropping the final possibly-partial record of a truncated
  window. Memory notes and the verifying tests: `src/imports/csv.ts` /
  `src/imports/csv.test.ts` (10MB fixture) and
  `test/imports.integration.test.ts` (asserts the read-back is ranged).
  Full-file parsing happens row-streamed in the import Workflow (#135),
  never in this worker.

## Testing

```sh
pnpm --filter @wellregarded/api test              # unit (no DB)
docker compose up -d && pnpm db:migrate
pnpm --filter @wellregarded/api test:integration  # real Postgres
```
