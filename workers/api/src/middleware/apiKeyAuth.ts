/**
 * Publishable API key middleware for the Proof API route group (issue #81,
 * Epic #4) — the parallel of `staffAuth` for the third auth surface.
 *
 * Answers "which practice's key is calling?" and publishes the answer as a
 * typed `ApiKeyActor` on context (`c.get("apiActor")`). `keyId` on the
 * actor is the identity future rate limiting buckets on (Epic #22 wires
 * the limiter; this middleware only exposes the identity), and `test` keys
 * behave identically but are flagged so proof routes can scope to
 * demo/staging data later.
 *
 * Status semantics: unknown, revoked, malformed, or absent key are ALL
 * `401 { error: "invalid_api_key" }` — one body, deliberately. Whether a
 * key exists or was revoked is information about a practice's credentials
 * that an unauthenticated public caller never gets. Malformed input is
 * rejected by `resolveApiKey`'s shape check before any hashing or DB work.
 *
 * The key arrives as `Authorization: Bearer pk_…`, with a `?key=pk_…`
 * query fallback — script-tag embeds can't always set headers. Query-param
 * keys end up in request logs by default; since these keys are publishable
 * (client-visible by design) that is acceptable, but docs and examples
 * prefer the header.
 */

import type { ApiKeyActor } from "@wellregarded/core";
import { resolveApiKey, touchApiKeyLastUsed } from "@wellregarded/db";
import type { Context, MiddlewareHandler } from "hono";

import type { AppEnv } from "../bindings";

function invalidApiKey(c: Context<AppEnv>) {
  return c.json({ error: "invalid_api_key" as const }, 401);
}

/**
 * `Authorization: Bearer pk_…` first, `?key=pk_…` as the fallback. As in
 * `staffAuth`, a malformed Authorization header never falls back — a
 * caller who tried to send a header gets header semantics.
 */
function keyFromRequest(c: Context<AppEnv>): string | null {
  const authorization = c.req.header("Authorization");
  if (authorization) {
    const [scheme, token] = authorization.split(" ");
    if (scheme?.toLowerCase() === "bearer" && token) return token;
    return null;
  }
  return c.req.query("key") ?? null;
}

/**
 * Requires `withDb()` upstream (it reads `c.get("db")`). On success sets
 * `apiActor` for every downstream handler and touches the key's
 * `last_used_at` off the request path: the UPDATE is started, handed to
 * `executionCtx.waitUntil` (so the runtime finishes it after the response
 * — the caller never waits on the write), and any failure is logged and
 * swallowed — `last_used_at` is best-effort observability, never worth
 * failing a request over. Outside a Workers runtime (tests run the app
 * without an ExecutionContext) the touch is awaited inline instead, which
 * also makes it deterministic to assert on.
 */
export function apiKeyAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = keyFromRequest(c);
    if (!key) return invalidApiKey(c);

    const db = c.get("db");
    const resolved = await resolveApiKey(db, key);
    // Unknown and revoked share one response on purpose — see module docs.
    if (!resolved) return invalidApiKey(c);

    const actor: ApiKeyActor = {
      type: "api_key",
      practiceId: resolved.apiKey.practiceId,
      keyId: resolved.apiKey.id,
      environment: resolved.apiKey.environment,
    };
    c.set("apiActor", actor);
    // Bind the tenant onto the request logger (issue #64).
    c.set("logger", c.get("logger").child({ practiceId: actor.practiceId }));

    const log = c.get("logger");
    const touching = touchApiKeyLastUsed(db, resolved.apiKey.id).catch(
      (error) => {
        log.error("api_keys.last_used_at touch failed", { error });
      },
    );
    let executionCtx:
      | { waitUntil(promise: Promise<unknown>): void }
      | undefined;
    try {
      executionCtx = c.executionCtx;
    } catch {
      executionCtx = undefined;
    }
    if (executionCtx) {
      executionCtx.waitUntil(touching);
    } else {
      await touching;
    }

    await next();
  };
}
