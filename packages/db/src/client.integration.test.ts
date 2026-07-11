import { afterAll, describe, expect, it } from "vitest";

import { createDb, type Db, type Sql } from "./client.js";

/**
 * Integration tests against a real Postgres (#40's CI canary).
 *
 * Only the `integration` Vitest project picks this file up — the
 * `*.integration.test.ts` glob never runs under `pnpm test` (see
 * vitest.config.ts). Run locally with:
 *
 *   docker compose up -d && pnpm db:migrate && \
 *     DATABASE_URL=postgres://... pnpm test:integration
 *
 * In CI the `integration` job provides a pgvector/pgvector:pg16 service
 * container and applies migrations before this runs. DATABASE_URL is
 * asserted, never skipped: a missing/misconfigured database must fail the
 * integration run loudly, not let it pass with zero tests executed. The
 * per-test isolation harness is a separate issue in Epic #3; until it lands
 * these tests hit the shared database directly.
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL must be set to run integration tests " +
      "(local compose default: postgres://wellregarded:wellregarded@localhost:54322/wellregarded). " +
      "Integration tests never skip — a missing database is a failure.",
  );
}

describe("createDb (integration)", () => {
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
