import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import * as schema from "./schema/index.js";

export type Db = PostgresJsDatabase<typeof schema>;
export type { Sql };

/**
 * Create a Drizzle client (and the underlying raw postgres-js client) for the
 * given connection string.
 *
 * Callers own configuration — this factory never reads globals (env
 * validation lives in `@wellregarded/core`):
 *
 * - Cloudflare Workers: `createDb(env.HYPERDRIVE.connectionString)`, created
 *   per-request. Isolates cannot reliably share sockets across requests, and
 *   Hyperdrive makes reconnects cheap.
 * - Node (local dev / CI): `createDb(process.env.DATABASE_URL)`.
 *
 * Defaults (see packages/db/README.md for the full rationale):
 *
 * - `prepare: false` — named prepared statements bind to a specific pooled
 *   backend connection and break under Hyperdrive's transaction-mode pooling.
 *   Off everywhere so local and prod behave identically.
 * - `max: 5` — Hyperdrive pools connections upstream; keep the client-side
 *   pool small.
 *
 * The raw `sql` client is exposed for hand-written queries (e.g. the
 * hybrid-search helper later in Epic #3).
 */
export function createDb(
  connectionString: string,
  opts?: { max?: number },
): { db: Db; sql: Sql } {
  const sql = postgres(connectionString, {
    prepare: false,
    max: opts?.max ?? 5,
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}
