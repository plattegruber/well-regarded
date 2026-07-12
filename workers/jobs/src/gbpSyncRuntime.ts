/**
 * Real-bindings wiring for the GBP sync engine (issue #123): the `SyncLock`
 * DO calls `runGoogleConnectionSync(env, input)`; everything testable lives
 * in ./gbpSync.ts behind structural deps. Kept out of sync-lock.ts so this
 * module never imports `cloudflare:workers` (Node unit tests can import it).
 *
 * DB lifecycle matches the pipeline stages: one client per sync, closed in
 * `finally` — isolates cannot reliably share sockets and Hyperdrive makes
 * reconnects cheap.
 */

import {
  createLogger,
  decryptField,
  type GoogleConnectionCredentials,
  getEnv,
  jobsEnvSchema,
  keyringFromEnv,
  logLevelFor,
} from "@wellregarded/core";
import { createDb } from "@wellregarded/db";
import {
  createGoogleAccessTokenProvider,
  listGbpReviewsPage,
} from "@wellregarded/sources";

import type { JobsBindings } from "./bindings";
import {
  type GbpSyncInput,
  type GbpSyncOutcome,
  syncGoogleConnection,
} from "./gbpSync";
import { createGbpSyncStore, persistNeedsReauth } from "./gbpSyncStore";

function requireBinding<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(
      `${name} binding is missing — the GBP poller cannot run. ` +
        "Check wrangler.jsonc (workers/jobs); bindings are NOT inherited " +
        "across envs.",
    );
  }
  return value;
}

function requireVar(value: string | undefined, name: string): string {
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is not configured — the GBP poller cannot refresh access ` +
        "tokens. See docs/secrets.md.",
    );
  }
  return value;
}

/** One connection sync against the real worker bindings. */
export async function runGoogleConnectionSync(
  env: JobsBindings,
  input: GbpSyncInput,
): Promise<GbpSyncOutcome> {
  const vars = getEnv(env, jobsEnvSchema);
  const hyperdrive = requireBinding(env.HYPERDRIVE, "HYPERDRIVE");
  const bucket = requireBinding(env.RAW_ARTIFACTS, "RAW_ARTIFACTS");
  const ingest = requireBinding(env.INGEST_QUEUE, "INGEST_QUEUE");
  const keyring = keyringFromEnv({
    PII_ENCRYPTION_KEYS: requireVar(
      vars.PII_ENCRYPTION_KEYS,
      "PII_ENCRYPTION_KEYS",
    ),
    PII_HASH_KEY: requireVar(vars.PII_HASH_KEY, "PII_HASH_KEY"),
  });

  const log = createLogger({
    worker: "jobs",
    requestId: input.requestId,
    stage: "gbp-sync",
    level: logLevelFor(vars.ENVIRONMENT),
  });

  const { db, sql } = createDb(hyperdrive.connectionString);
  try {
    const tokenProvider = createGoogleAccessTokenProvider({
      config: {
        tokenUrl: vars.GOOGLE_OAUTH_TOKEN_URL,
        clientId: requireVar(vars.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID"),
        clientSecret: requireVar(
          vars.GOOGLE_CLIENT_SECRET,
          "GOOGLE_CLIENT_SECRET",
        ),
      },
      // Durable BEFORE NeedsReauthError propagates: status flip + system
      // audit row in one transaction (see gbpSyncStore.ts).
      onInvalidGrant: (connectionId) => persistNeedsReauth(db, connectionId),
    });

    return await syncGoogleConnection(
      {
        store: createGbpSyncStore(db),
        bucket,
        ingest,
        getAccessToken: (connection) =>
          tokenProvider.getAccessToken(connection),
        decryptCredentials: async (ciphertext) =>
          JSON.parse(
            await decryptField(ciphertext, keyring),
          ) as GoogleConnectionCredentials,
        listReviewsPage: (pageInput) =>
          listGbpReviewsPage(
            { v4BaseUrl: vars.GOOGLE_MYBUSINESS_V4_BASE_URL },
            pageInput,
          ),
        log,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      input,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}
