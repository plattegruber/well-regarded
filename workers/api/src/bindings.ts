/**
 * Types for the api worker's environment and Hono context.
 *
 * Split of responsibilities (see packages/core/src/env.ts header):
 * - string vars/secrets are validated per-request via
 *   `getEnv(c.env, apiEnvSchema)` — never read them off `c.env` directly;
 * - resource bindings (Hyperdrive, KV, queues, …) are runtime-injected
 *   objects typed here, consumed directly off `c.env`.
 */

import type { StaffActor } from "@wellregarded/core";
import type { Db } from "@wellregarded/db";

/**
 * The bindings this worker's code actually consumes, typed structurally so
 * tests can inject minimal fakes (e.g. `HYPERDRIVE: { connectionString }`).
 * wrangler.jsonc's binding list is the source of truth; the string vars are
 * intentionally untyped here — `getEnv` owns them.
 */
export interface ApiBindings {
  /** Hyperdrive → Postgres. Only the connection string is consumed. */
  HYPERDRIVE: { connectionString: string };
  /** String vars/secrets, validated by `getEnv(c.env, apiEnvSchema)`. */
  [key: string]: unknown;
}

/**
 * The app-wide Hono type (issue #68 requirement 4): middleware sets both
 * `actor` and `db`, so every handler downstream of the staff-auth group is
 * practice-scoped by construction.
 */
export type AppEnv = {
  Bindings: ApiBindings;
  Variables: {
    actor: StaffActor;
    db: Db;
  };
};
