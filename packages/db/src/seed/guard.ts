/**
 * Safety guard for the seed CLI (issue #32 requirement 3): the seed
 * wipes and recreates the demo practice, so it must be impossible to point
 * it at a shared database by accident.
 *
 * Two independent rules, checked in order:
 *
 * 1. `ENVIRONMENT=prod` refuses ALWAYS — no `--force` override. There is
 *    no legitimate reason to run demo fixtures against production.
 * 2. A `DATABASE_URL` whose host is not loopback refuses unless `--force`
 *    is passed (preview/staging databases are sometimes legitimately
 *    reseeded, but only deliberately).
 *
 * Pure and synchronous so the unit suite can cover every branch without a
 * database (`guard.test.ts`).
 */

/** Thrown when the guard refuses; the CLI prints `message` and exits 1. */
export class SeedGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedGuardError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface SeedGuardInput {
  databaseUrl: string;
  /** `process.env.ENVIRONMENT` — the local/preview/prod convention. */
  environment: string | undefined;
  /** `--force` was passed. */
  force: boolean;
}

/** Throws `SeedGuardError` unless seeding this target is allowed. */
export function assertSeedTargetAllowed(input: SeedGuardInput): void {
  if (input.environment === "prod") {
    throw new SeedGuardError(
      "Refusing to seed: ENVIRONMENT=prod. The demo seed wipes and " +
        "recreates the demo practice and must never run against " +
        "production. There is no override.",
    );
  }

  let host: string;
  try {
    host = new URL(input.databaseUrl).hostname;
  } catch {
    throw new SeedGuardError(
      "Refusing to seed: DATABASE_URL is not a parseable URL, so the " +
        "target cannot be verified as local.",
    );
  }

  if (!LOOPBACK_HOSTS.has(host) && !input.force) {
    throw new SeedGuardError(
      `Refusing to seed: DATABASE_URL points at "${host}", which is not ` +
        "a local database. Pass --force only if you are certain this " +
        "target (e.g. a preview database) should be reseeded.",
    );
  }
}
