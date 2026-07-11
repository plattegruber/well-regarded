/**
 * Per-request database client (Epic #3's connection factory over the
 * Hyperdrive binding).
 *
 * One client per request, never cached in module scope: isolates cannot
 * reliably share sockets across requests, Hyperdrive makes reconnects
 * cheap, and per-request construction is what makes staleness bugs
 * impossible. Downstream handlers read it via `c.get("db")`.
 */

import { createDb } from "@wellregarded/db";
import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../bindings";

export function withDb(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { db, sql } = createDb(c.env.HYPERDRIVE.connectionString);
    c.set("db", db);
    try {
      await next();
    } finally {
      // Close the pool without delaying the response when the runtime
      // gives us a lifecycle hook; awaiting inline otherwise (tests run
      // the app without an ExecutionContext). Handlers in this worker
      // produce buffered JSON responses, so `next()` resolving means the
      // DB work is done.
      const closing = sql.end({ timeout: 5 });
      let executionCtx:
        | { waitUntil(promise: Promise<unknown>): void }
        | undefined;
      try {
        executionCtx = c.executionCtx;
      } catch {
        executionCtx = undefined;
      }
      if (executionCtx) {
        executionCtx.waitUntil(closing);
      } else {
        await closing;
      }
    }
  };
}
