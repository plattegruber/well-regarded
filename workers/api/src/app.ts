/**
 * The Hono app for the api worker, exported separately from the wrangler
 * entrypoint (src/worker.ts) so tests can drive it with `app.request()`
 * under Node, injecting fake bindings per request.
 *
 * Deliberately minimal: bootstrap + auth surfaces only. Real dashboard API
 * route groups land with the API epic.
 */

import {
  apiEnvSchema,
  createLogger,
  fallbackRequestId,
  getEnv,
} from "@wellregarded/core";
import { Hono } from "hono";

import type { AppEnv } from "./bindings";
import { apiKeyAuth } from "./middleware/apiKeyAuth";
import { requestId } from "./middleware/requestId";
import { staffAuth } from "./middleware/staffAuth";
import { withDb } from "./middleware/withDb";
import { apiKeyRoutes } from "./routes/apiKeys";
import { importRoutes } from "./routes/imports";
import { googleIntegrationRoutes } from "./routes/integrations/google";
import { signalRoutes } from "./routes/signals";
import { clerkWebhook } from "./routes/webhooks/clerk";

export const app = new Hono<AppEnv>();

// First middleware, deliberately (issue #64): everything downstream —
// including onError — logs with the request id, and every response carries
// the x-request-id header.
app.use("*", requestId());

app.onError((error, c) => {
  // Log server-side, never echo internals to the client. The fallback
  // logger only fires if the error escaped the requestId middleware itself.
  const log =
    c.get("logger") ??
    createLogger({ worker: "api", requestId: fallbackRequestId() });
  log.error("unhandled error", { error });
  return c.json({ error: "internal" as const }, 500);
});

/** Unauthenticated liveness probe. */
app.get("/healthz", (c) => {
  const env = getEnv(c.env, apiEnvSchema);
  return c.json({ ok: true, environment: env.ENVIRONMENT });
});

// ---------------------------------------------------------------------------
// Route grouping convention (issue #68 requirement 6) — READ BEFORE ADDING
// A ROUTE:
//
// 1. Staff dashboard routes go on the `staff` router below. It runs
//    `withDb()` + `staffAuth()` for you: your handler gets `c.get("db")`
//    (per-request client) and `c.get("actor")` (verified StaffActor) and is
//    practice-scoped by construction. Gate practice-level permissions with
//    `requirePermission(action)`; do resource-level location checks in the
//    handler with `can()` and the real resource.
//
// 2. Webhooks live under `/webhooks/*`, OUTSIDE staff auth — their only
//    auth is the provider's signature (svix for Clerk). They still get
//    `withDb()`.
//
// 3. Proof API routes (issue #81) go on the `proof` router below, OUTSIDE
//    staff auth, behind `apiKeyAuth()` — publishable `pk_live_`/`pk_test_`
//    keys resolve to a typed `ApiKeyActor` at `c.get("apiActor")`. A route
//    group mounts exactly ONE auth middleware: nothing may ever accept
//    both staff JWTs and API keys.
// ---------------------------------------------------------------------------

const webhooks = new Hono<AppEnv>();
webhooks.use("*", withDb());
webhooks.route("/", clerkWebhook);
app.route("/webhooks", webhooks);

const staff = new Hono<AppEnv>();
staff.use("*", withDb());
staff.use("*", staffAuth());

/** Who am I — the smallest practice-scoped route; also exercised by tests. */
staff.get("/me", (c) => c.json({ actor: c.get("actor") }));

/** Key management (issue #81): owner-gated via manage_api_keys. */
staff.route("/api-keys", apiKeyRoutes);

/** CSV import upload + mapping drafts (issue #133): manage_settings-gated. */
staff.route("/imports", importRoutes);

/** Google Business Profile OAuth (issue #118): gated via manage_settings. */
staff.route("/integrations/google", googleIntegrationRoutes);

/** Manual signal entry (issue #138): permission checks in the handler. */
staff.route("/signals", signalRoutes);

app.route("/api", staff);

const proof = new Hono<AppEnv>();
proof.use("*", withDb());
proof.use("*", apiKeyAuth());

/** Which practice am I — the smallest key-scoped route; exercised by tests. */
proof.get("/me", (c) => c.json({ actor: c.get("apiActor") }));

app.route("/proof", proof);
