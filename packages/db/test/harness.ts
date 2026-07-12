/**
 * Per-test-file database isolation (issue #49, Epic #3).
 *
 * `setupTestDb()` — call once at describe-file scope — clones the
 * fully-migrated `wellregarded_template` (built by `./globalSetup.ts`) into
 * a throwaway database for this file, and drops it afterward. Test files
 * can never see each other's rows, need no cleanup code, and run against
 * the real schema: extensions, both Postgres schemas, cross-schema FKs,
 * and triggers included.
 *
 * Usage:
 *
 *   import { setupTestDb } from "../../test/harness.js";
 *   import { practice, signal } from "../../test/factories.js";
 *
 *   const t = setupTestDb();
 *
 *   it("does the thing", async () => {
 *     const p = await practice(t.db);
 *     ...
 *   });
 *
 * See CONTRIBUTING.md § "Writing DB tests".
 */

import { faker } from "@faker-js/faker";
import postgres from "postgres";
import { afterAll, beforeAll } from "vitest";

import { createDb, type Db, type Sql } from "../src/client.js";
import {
  assertSafeIdentifier,
  MAINTENANCE_DB,
  OBJECT_IN_USE,
  requireDatabaseUrl,
  TEMPLATE_DB,
  withDatabase,
} from "./support.js";

export { pgError, pgErrorInfo } from "./support.js";

export interface TestDb {
  /** Drizzle client bound to this file's private database. */
  readonly db: Db;
  /** The raw postgres-js client underneath `db`. */
  readonly sql: Sql;
  /**
   * This file's database name (`test_<created-epoch>_<pid>_<n>`), for
   * assertions. The leading epoch (seconds) is load-bearing: the orphan
   * sweep in `./globalSetup.ts` uses it to distinguish a crashed run's
   * leftovers from a live concurrent run's fresh databases — postgres-js
   * connects lazily, so "no connections yet" never proves a database is
   * abandoned.
   */
  readonly databaseName: string;
}

/** Monotonic per-process counter — several files can share a worker. */
let fileCounter = 0;

/**
 * Register beforeAll/afterAll hooks in the current scope that create this
 * file's private database from the template and drop it when the scope
 * finishes. Access `.db` / `.sql` only inside tests or later hooks (they
 * throw before beforeAll has run).
 */
export function setupTestDb(): TestDb {
  const state: { db?: Db; sql?: Sql; databaseName?: string } = {};

  beforeAll(async () => {
    // Fixed seed per file (requirement 5): failures reproduce identically
    // no matter which other files ran first in this worker.
    faker.seed(1234);

    const databaseUrl = requireDatabaseUrl();
    // Creation epoch first (see the TestDb doc), then pid + counter for
    // uniqueness across workers and files.
    const databaseName = assertSafeIdentifier(
      `test_${Math.floor(Date.now() / 1000)}_${process.pid}_${++fileCounter}`,
    );

    await withMaintenance(databaseUrl, async (maintenance) => {
      const create = () =>
        maintenance.unsafe(
          `CREATE DATABASE "${databaseName}" TEMPLATE "${TEMPLATE_DB}"`,
        );
      try {
        await create();
      } catch (error) {
        // 55006: the template briefly still has a closing connection (e.g.
        // globalSetup's migration backend winding down). Retry once.
        if ((error as { code?: string }).code !== OBJECT_IN_USE) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
        await create();
      }
    });

    // max: 1, prepare: false — mirrors production posture, and a single
    // connection means afterAll's sql.end() never leaves the Vitest
    // process hanging on an idle pool member.
    const { db, sql } = createDb(withDatabase(databaseUrl, databaseName), {
      max: 1,
    });
    state.db = db;
    state.sql = sql;
    state.databaseName = databaseName;
  });

  afterAll(async () => {
    await state.sql?.end();
    if (!state.databaseName) return;
    const databaseUrl = requireDatabaseUrl();
    await withMaintenance(databaseUrl, async (maintenance) => {
      // WITH (FORCE): our own connection is closed above; FORCE only ever
      // reaps a leaked one so a buggy test cannot wedge the drop.
      await maintenance.unsafe(
        `DROP DATABASE IF EXISTS "${state.databaseName}" WITH (FORCE)`,
      );
    });
  });

  return {
    get db() {
      return required(state.db, "db");
    },
    get sql() {
      return required(state.sql, "sql");
    },
    get databaseName() {
      return required(state.databaseName, "databaseName");
    },
  };
}

async function withMaintenance(
  databaseUrl: string,
  fn: (maintenance: Sql) => Promise<void>,
): Promise<void> {
  const maintenance = postgres(withDatabase(databaseUrl, MAINTENANCE_DB), {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
  try {
    await fn(maintenance);
  } finally {
    await maintenance.end();
  }
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(
      `setupTestDb().${what} accessed before beforeAll ran — ` +
        "use it only inside tests or later hooks.",
    );
  }
  return value;
}
