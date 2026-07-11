/**
 * Seed CLI (issue #32) — `pnpm seed` from the repo root, or
 * `pnpm --filter @wellregarded/db seed`.
 *
 * Connects via `DATABASE_URL` (defaulting to the canonical local compose
 * string), refuses non-local targets unless `--force` and refuses
 * `ENVIRONMENT=prod` unconditionally (see ./guard.ts), then runs the
 * wipe-and-recreate seed in one transaction.
 *
 * Keyring: prefers `PII_ENCRYPTION_KEYS`/`PII_HASH_KEY` from the
 * environment (a developer with rotated local keys), else the committed
 * dev keyring that matches every `.dev.vars.example`.
 */

import { keyringFromEnv } from "@wellregarded/core";

import { createDb } from "../client.js";
import { SEED_VERSION } from "./constants.js";
import { devKeyring } from "./devKeyring.js";
import { assertSeedTargetAllowed, SeedGuardError } from "./guard.js";
import { runSeed } from "./run.js";

// This file is Node-only (never bundled into a Worker), but the workspace
// deliberately has no @types/node — src/ stays runtime-neutral. Declare the
// minimal process surface the CLI touches.
declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exitCode: number | undefined;
};

/** Canonical local connection string — docker-compose.yml / setup.sh. */
const LOCAL_DATABASE_URL =
  "postgres://wellregarded:wellregarded@localhost:54322/wellregarded";

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;

  assertSeedTargetAllowed({
    databaseUrl,
    environment: process.env.ENVIRONMENT,
    force,
  });

  const envKeys = process.env.PII_ENCRYPTION_KEYS;
  const envHash = process.env.PII_HASH_KEY;
  const keyring =
    envKeys && envHash
      ? keyringFromEnv({ PII_ENCRYPTION_KEYS: envKeys, PII_HASH_KEY: envHash })
      : devKeyring();

  const { db, sql } = createDb(databaseUrl, { max: 1 });
  try {
    const summary = await runSeed(db, { keyring });
    console.log(
      `Seeded demo practice "Cedar Ridge Dental" (seed v${SEED_VERSION}, practice ${summary.practiceId}):`,
    );
    console.log(
      `  ${summary.locations} locations, ${summary.providers} providers, ` +
        `${summary.staffMembers} staff, ${summary.patients} patients ` +
        `(${summary.contactPoints} encrypted contact points)`,
    );
    console.log(
      `  ${summary.signals} signals, ${summary.derivations} derivations, ` +
        `${summary.consents} consents, ${summary.proofExcerpts} proof excerpts ` +
        "(embeddings left NULL — backfill is Epic #9)",
    );
    console.log(
      `  ${summary.importRuns} import run (the legacy CSV feedback export)`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  if (error instanceof SeedGuardError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
