/**
 * Shared plumbing for the DB test harness (issue #49, Epic #3) — everything
 * both `globalSetup.ts` and `harness.ts` need, with **no vitest imports**
 * (globalSetup runs outside the test runner context and must not pull in
 * vitest's test APIs).
 *
 * Isolation strategy (why template databases, not schema-per-worker):
 * our schema spans two Postgres schemas (`public` + `pii`, with
 * cross-schema FKs like `signals.patient_id → pii.patients`), the pgvector
 * extension, and hand-written triggers (0004, 0008). `search_path` juggling
 * cannot relocate any of that cleanly — a template copy is byte-exact.
 * `CREATE DATABASE ... TEMPLATE wellregarded_template` clones the fully
 * migrated template in milliseconds with no re-migration.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The fully-migrated template every test database is cloned from. */
export const TEMPLATE_DB = "wellregarded_template";

/**
 * Maintenance database for CREATE/DROP DATABASE — never the template (a
 * connection to the template blocks cloning) and never a database we drop.
 * `postgres` always exists (both the CI service container and the local
 * compose image create it).
 */
export const MAINTENANCE_DB = "postgres";

/** Absolute path to `packages/db/migrations`. */
export const MIGRATIONS_DIR = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

/** `55006` — "source database is being accessed by other users". */
export const OBJECT_IN_USE = "55006";

/**
 * DATABASE_URL, asserted loudly. Integration tests never skip — a missing
 * database is a failure, not zero tests executed (see CONTRIBUTING.md).
 */
export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL must be set to run integration tests " +
        "(local compose default: postgres://wellregarded:wellregarded@localhost:54322/wellregarded). " +
        "Integration tests never skip — a missing database is a failure.",
    );
  }
  return url;
}

/** The same connection string pointed at a different database. */
export function withDatabase(connectionString: string, dbName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/**
 * Guard for identifiers we interpolate into unparameterizable DDL
 * (CREATE/DROP DATABASE take no bind parameters). Every name we generate
 * matches; anything else is a bug, not input to escape.
 */
export function assertSafeIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe database identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Deterministic fingerprint of the migrations folder (every `*.sql` plus
 * the drizzle journal/snapshots). Stored as a COMMENT on the template
 * database; a mismatch means the template is stale and gets rebuilt.
 */
export function migrationsHash(): string {
  const hash = createHash("sha256");
  for (const relative of listFilesRecursively(MIGRATIONS_DIR).sort()) {
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(join(MIGRATIONS_DIR, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function listFilesRecursively(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), {
    withFileTypes: true,
  })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFilesRecursively(dir, relative));
    } else {
      files.push(relative);
    }
  }
  return files;
}

/**
 * Extract the Postgres error code and message from anything a query path
 * throws. drizzle-orm wraps driver errors in DrizzleQueryError with the
 * postgres-js PostgresError on `cause`, so both layers are checked.
 */
export function pgErrorInfo(error: unknown): { code: string; message: string } {
  const e = error as {
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  return {
    code: e.code ?? e.cause?.code ?? "",
    message: [e.message, e.cause?.message].filter(Boolean).join(" | "),
  };
}

/**
 * Await a promise expected to reject with a Postgres error; returns the
 * error code and message (or `code: "no error thrown"`). The idiom every
 * constraint/trigger test in this package asserts with.
 */
export async function pgError(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return pgErrorInfo(error);
  }
  return { code: "no error thrown", message: "" };
}
