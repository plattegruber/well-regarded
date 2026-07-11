/**
 * The Hono app for the api worker, exported separately from the wrangler
 * entrypoint (src/worker.ts) so tests can drive it with `app.request()`
 * under Node, injecting fake bindings per request.
 *
 * Deliberately minimal: bootstrap + auth surfaces only. Real dashboard API
 * route groups land with the API epic.
 */

import { apiEnvSchema, getEnv } from "@wellregarded/core";
import { Hono } from "hono";

import type { AppEnv } from "./bindings";
import { staffAuth } from "./middleware/staffAuth";
import { withDb } from "./middleware/withDb";
import { clerkWebhook } from "./routes/webhooks/clerk";

export const app = new Hono<AppEnv>();

app.onError((error, c) => {
  // Log server-side, never echo internals to the client.
  console.error("unhandled error:", error);
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
// 3. Future proof-API routes (publishable API keys, separate issue) also
//    stay outside staff auth and will bring their own key-auth middleware.
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

app.route("/api", staff);
