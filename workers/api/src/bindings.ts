/**
 * Types for the api worker's environment and Hono context.
 *
 * Split of responsibilities (see packages/core/src/env.ts header):
 * - string vars/secrets are validated per-request via
 *   `getEnv(c.env, apiEnvSchema)` — never read them off `c.env` directly;
 * - resource bindings (Hyperdrive, KV, queues, …) are runtime-injected
 *   objects typed here, consumed directly off `c.env`.
 */

import type { ApiKeyActor, Logger, StaffActor } from "@wellregarded/core";
import type { Db } from "@wellregarded/db";
import type { RawImportBucket } from "@wellregarded/sources";

/**
 * The bindings this worker's code actually consumes, typed structurally so
 * tests can inject minimal fakes (e.g. `HYPERDRIVE: { connectionString }`).
 * wrangler.jsonc's binding list is the source of truth; the string vars are
 * intentionally untyped here — `getEnv` owns them.
 */
export interface ApiBindings {
  /** Hyperdrive → Postgres. Only the connection string is consumed. */
  HYPERDRIVE: { connectionString: string };
  /**
   * R2: uploaded/imported source files (`wr-raw-imports-<env>`). Typed as
   * the structural subset from `@wellregarded/sources` so tests inject
   * `InMemoryRawArtifactBucket`; the real `R2Bucket` satisfies it.
   */
  RAW_IMPORTS: RawImportBucket;
  /**
   * KV for single-use OAuth state records (issue #118): the Google connect
   * flow stores `{ verifier, practiceId, staffId }` under the state nonce
   * with a 10-minute TTL; the callback deletes on read. Only the three
   * methods the flow uses are typed — tests inject a Map-backed fake.
   */
  OAUTH_STATE: {
    get(key: string): Promise<string | null>;
    put(
      key: string,
      value: string,
      options?: { expirationTtl?: number },
    ): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /**
   * Cross-script Workflow binding to `wr-csv-import-<env>` (class
   * `CsvImport` in workers/jobs, issue #135): the start endpoint (#134)
   * creates one instance per confirmed draft. Optional — a local `wrangler
   * dev` without the jobs worker still confirms drafts (the Workflow is
   * triggerable later; see docs/csv-import.md § Triggering). Only `create`
   * is consumed.
   */
  CSV_IMPORT?:
    | { create(options?: { params?: unknown }): Promise<{ id: string }> }
    | undefined;
  /** String vars/secrets, validated by `getEnv(c.env, apiEnvSchema)`. */
  [key: string]: unknown;
}

/**
 * The app-wide Hono type (issue #68 requirement 4): middleware sets `db`
 * plus the actor for its route group — `actor` (StaffActor) downstream of
 * `staffAuth`, `apiActor` (ApiKeyActor, issue #81) downstream of
 * `apiKeyAuth` — so every handler is practice-scoped by construction. A
 * route group mounts exactly one of the two auth middlewares; no route
 * ever accepts both credential types.
 */
export type AppEnv = {
  Bindings: ApiBindings;
  Variables: {
    actor: StaffActor;
    apiActor: ApiKeyActor;
    db: Db;
    /** Trace id resolved by the requestId middleware (issue #64). */
    requestId: string;
    /** Request-bound structured logger (packages/core/src/log). */
    logger: Logger;
  };
};
