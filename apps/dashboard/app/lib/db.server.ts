// Per-request database client over the Hyperdrive binding — the dashboard
// twin of the API worker's `withDb` middleware (workers/api/src/middleware/
// withDb.ts). One client per request, never cached in module scope:
// isolates cannot reliably share sockets across requests, Hyperdrive makes
// reconnects cheap, and per-request construction makes staleness bugs
// impossible.
//
// Loaders/actions call `withRequestDb(context, fn)`; the pool closes via
// `waitUntil` after the response (the callback resolving means the DB work
// is done — loaders return plain data, not streams).
import { createDb, type Db } from "@wellregarded/db";
import type { AppLoadContext } from "react-router";

export async function withRequestDb<T>(
  context: AppLoadContext,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const { db, sql } = createDb(
    context.cloudflare.env.HYPERDRIVE.connectionString,
  );
  try {
    return await fn(db);
  } finally {
    context.cloudflare.ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}
