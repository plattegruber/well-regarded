# Clerk setup

How the Clerk application is wired into Well Regarded. This page covers the
**webhook sync** (issue #60) and the **API JWT verification** inputs
(issue #68); the dashboard's Clerk ↔ React Router integration (Epic #5)
extends this file when it lands.

Model: **Clerk Organization = practice**. Clerk owns authentication and org
membership; our database owns everything else (roles, location scoping,
every FK). The webhook sync mirrors orgs and memberships into `practices`
and `staff_members`; the JWT middleware then resolves a signed-in user's
practice and staff row from those tables — a user whose org has not synced
yet gets `403 { reason: "unknown_org" }` until the webhook arrives.

There is **no live Clerk application yet** — everything below is what to do
once one exists. Env-var specifics live in
[`docs/secrets.md`](./secrets.md) § "Flipping on real Clerk keys".

## Webhook endpoint (Clerk dashboard → Webhooks)

1. Add an endpoint pointing at the api worker:
   - preview: `https://<wr-api-preview host>/webhooks/clerk`
   - prod: `https://<wr-api-prod host>/webhooks/clerk`
2. Subscribe to exactly these events (anything else is acked and ignored):
   - `organization.created`, `organization.updated`
   - `organizationMembership.created`, `organizationMembership.updated`,
     `organizationMembership.deleted`
   - `user.updated`
3. Copy the endpoint's **signing secret** (`whsec_…`) into
   `CLERK_WEBHOOK_SIGNING_SECRET` (see
   [`docs/secrets.md`](./secrets.md) — one secret per endpoint, so preview
   and prod each get their own).

Behavior contract (implemented in
`workers/api/src/routes/webhooks/clerk.ts`):

- The svix signature is the route's **only** auth; it is verified against
  the raw request body before any JSON parsing. Missing/invalid signature
  → `400` with no detail.
- All handlers are idempotent upserts — Clerk/svix retries and replays are
  safe, including out-of-order delivery (a membership event for an unseen
  org creates the practice from the event's nested `organization` first).
- Membership removal soft-deletes (`deactivated_at`); re-adding the member
  reactivates the same row.
- Roles map via `ROLE_MAP` in `packages/core` (`org:admin → owner`,
  `org:member → front_desk`, unknown → `front_desk` + warning) and are set
  **on insert only** — the sync never overwrites a role changed in our DB.

## Local webhook testing

Two options:

- **Tunnel real deliveries**: run the worker (`pnpm dev`, api on
  `localhost:8787`), expose it with
  `cloudflared tunnel --url http://localhost:8787` (or
  `ngrok http 8787`), point a Clerk dev-instance webhook endpoint at
  `https://<tunnel-host>/webhooks/clerk`, and set that endpoint's signing
  secret in `workers/api/.dev.vars`. Clerk's dashboard can **replay** any
  delivery, which is the fastest way to iterate on a handler.
- **No Clerk at all**: the worker tests generate real svix signatures with
  a known test secret against canned payloads
  (`workers/api/test/fixtures/clerk/`) — see
  `workers/api/test/webhooks.integration.test.ts`. This is what CI runs.

## Session-token verification (api worker)

`workers/api` verifies Clerk session JWTs **networklessly**: the middleware
(`workers/api/src/middleware/staffAuth.ts`) checks the RS256 signature
against `CLERK_JWKS_PUBLIC_KEY` (PEM from the Clerk dashboard's API-keys
page) — no Clerk API call per request. Set `CLERK_AUTHORIZED_PARTIES` to
the dashboard origin(s) so tokens minted for other origins are rejected via
their `azp` claim. Both claim formats (v1 `org_id`/`org_role`, v2
`o.id`/`o.rol`) are supported.
