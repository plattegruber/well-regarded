import { afterAll, describe, expect, it } from "vitest";

import { createDb, type Db, type Sql } from "./client.js";

/**
 * Integration tests against a real Postgres (the local compose database).
 *
 * Run with:
 *
 *   docker compose up -d && pnpm db:migrate && \
 *     DATABASE_URL=postgres://... pnpm --filter @wellregarded/db test
 *
 * Skipped automatically when DATABASE_URL is not set so the plain unit-test
 * run (`pnpm test` without a database) stays green. The per-test isolation
 * harness is a separate issue in Epic #3; until it lands these tests hit the
 * shared local database directly.
 */
const connectionString = process.env.DATABASE_URL ?? "";

describe.skipIf(!connectionString)("createDb (integration)", () => {
  let db: Db;
  let sql: Sql;

  afterAll(async () => {
    await sql?.end();
  });

  it("connects and runs SELECT 1", async () => {
    ({ db, sql } = createDb(connectionString));
    const rows = await sql`SELECT 1 AS one`;
    expect(rows).toEqual([{ one: 1 }]);
  });

  it("has the vector extension installed (migration 0001)", async () => {
    const rows = await sql`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `;
    expect(rows).toHaveLength(1);
  });

  it("has the pii schema (migration 0001)", async () => {
    const rows = await sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name = 'pii'
    `;
    expect(rows).toHaveLength(1);
  });

  it("runs queries through the drizzle client too", async () => {
    const result = await db.execute("SELECT 2 AS two");
    expect(result).toEqual([{ two: 2 }]);
  });
});
