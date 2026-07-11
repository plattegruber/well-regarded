/**
 * Vitest globalSetup for the integration project (issue #49, Epic #3).
 *
 * Builds (or reuses) `wellregarded_template`: a database with every
 * migration applied, from which each test file clones its own throwaway
 * database via `setupTestDb()` in `./harness.ts`. Cloning is milliseconds;
 * migrations run at most once per migrations-folder change.
 *
 * Warm path (template exists and its stored fingerprint matches the current
 * migrations folder): a couple of catalog queries plus the orphan sweep —
 * well under the ~2s budget. Cold path: drop + recreate the template and
 * run all migrations into it once.
 *
 * The migration connection is closed before this function returns —
 * `CREATE DATABASE ... TEMPLATE` requires no other connections to the
 * template, and test files start only after globalSetup resolves.
 */

import { faker } from "@faker-js/faker";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import {
  assertSafeIdentifier,
  MAINTENANCE_DB,
  MIGRATIONS_DIR,
  migrationsHash,
  OBJECT_IN_USE,
  requireDatabaseUrl,
  TEMPLATE_DB,
  withDatabase,
} from "./support.js";

/**
 * Advisory lock key serializing template builds — two integration runs
 * against the same server (e.g. turbo running future workspaces' suites in
 * parallel) must not race the drop/create/migrate sequence.
 */
const TEMPLATE_BUILD_LOCK = 490_349; // arbitrary; unique to this harness

export default async function globalSetup(): Promise<void> {
  // Deterministic data (requirement 5): seeded here for anything generated
  // during setup, and re-seeded per test file in setupTestDb() so failures
  // reproduce regardless of which files ran first.
  faker.seed(1234);

  const databaseUrl = requireDatabaseUrl();
  const maintenance = postgres(withDatabase(databaseUrl, MAINTENANCE_DB), {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });

  try {
    await maintenance`SELECT pg_advisory_lock(${TEMPLATE_BUILD_LOCK})`;

    const expectedFingerprint = `migrations sha256:${migrationsHash()}`;
    const [existing] = await maintenance`
      SELECT shobj_description(oid, 'pg_database') AS fingerprint
      FROM pg_database WHERE datname = ${TEMPLATE_DB}
    `;

    if (existing?.fingerprint === expectedFingerprint) {
      // Warm path: template already matches the migrations folder.
    } else {
      await buildTemplate(maintenance, databaseUrl, expectedFingerprint);
    }

    await sweepOrphans(maintenance);
    await maintenance`SELECT pg_advisory_unlock(${TEMPLATE_BUILD_LOCK})`;
  } finally {
    await maintenance.end();
  }
}

type Maintenance = postgres.Sql;

async function buildTemplate(
  maintenance: Maintenance,
  databaseUrl: string,
  fingerprint: string,
): Promise<void> {
  assertSafeIdentifier(TEMPLATE_DB);
  // WITH (FORCE): a crashed previous run may have left a connection open to
  // the template; nothing is ever legitimately connected to it while we
  // hold the build lock.
  await maintenance.unsafe(
    `DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`,
  );
  await maintenance.unsafe(`CREATE DATABASE "${TEMPLATE_DB}"`);

  // Run every migration into the template, then close the connection —
  // an open connection to the template makes clones fail with 55006.
  const templateSql = postgres(withDatabase(databaseUrl, TEMPLATE_DB), {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
  try {
    await migrate(drizzle(templateSql), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await templateSql.end();
  }

  // Fingerprint lives in the database COMMENT so the warm-path check never
  // has to connect to the template itself. Hex hash — safe to inline.
  await maintenance.unsafe(
    `COMMENT ON DATABASE "${TEMPLATE_DB}" IS '${fingerprint}'`,
  );
}

/**
 * Drop leftover `test_%` databases from crashed runs so they never
 * accumulate. Plain DROP (no FORCE): a database still in use — e.g. a
 * concurrent integration run on the same server — fails with 55006 and is
 * skipped, never killed.
 */
async function sweepOrphans(maintenance: Maintenance): Promise<void> {
  const orphans = await maintenance`
    SELECT datname FROM pg_database WHERE datname LIKE ${"test\\_%"}
  `;
  for (const { datname } of orphans) {
    try {
      await maintenance.unsafe(
        `DROP DATABASE IF EXISTS "${assertSafeIdentifier(datname)}"`,
      );
    } catch (error) {
      if ((error as { code?: string }).code !== OBJECT_IN_USE) throw error;
    }
  }
}
