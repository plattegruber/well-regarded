import { describe, expect, it } from "vitest";

import { setupTestDb } from "../test/harness.js";

/**
 * Integration tests against a real Postgres (#40's CI canary), on the #49
 * harness: this file gets its own database cloned from the fully-migrated
 * template (see test/harness.ts). Run locally with:
 *
 *   docker compose up -d && pnpm --filter @wellregarded/db test:integration
 *
 * DATABASE_URL is asserted by the harness, never skipped: a missing or
 * misconfigured database must fail the integration run loudly, not let it
 * pass with zero tests executed.
 */
describe("createDb (integration)", () => {
  const t = setupTestDb();

  it("connects and runs SELECT 1", async () => {
    const rows = await t.sql`SELECT 1 AS one`;
    expect(rows).toEqual([{ one: 1 }]);
  });

  it("has the vector extension installed (migration 0001)", async () => {
    const rows = await t.sql`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `;
    expect(rows).toHaveLength(1);
  });

  it("has the pii schema (migration 0001)", async () => {
    const rows = await t.sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name = 'pii'
    `;
    expect(rows).toHaveLength(1);
  });

  it("runs queries through the drizzle client too", async () => {
    const result = await t.db.execute("SELECT 2 AS two");
    expect(result).toEqual([{ two: 2 }]);
  });
});
