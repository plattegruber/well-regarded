/**
 * Fake worker envs for `app.request(path, init, env)`. Bindings are
 * structural (see src/bindings.ts): tests inject a plain
 * `{ connectionString }` for HYPERDRIVE.
 *
 * `getEnv` caches its parse per isolate — tests that vary env values
 * between requests must call `resetEnvCache()` (from @wellregarded/core)
 * in a beforeEach.
 */

import { TEST_WEBHOOK_SECRET } from "./webhooks";

export interface TestEnv {
  ENVIRONMENT: string;
  HYPERDRIVE: { connectionString: string };
  [key: string]: unknown;
}

/**
 * For unit tests that must never touch a database: postgres-js connects
 * lazily, so a request that (correctly) performs no query never dials
 * this address.
 */
export const UNREACHABLE_DB =
  "postgres://nobody:nowhere@127.0.0.1:1/unreachable";

export function testEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  return {
    ENVIRONMENT: "local",
    HYPERDRIVE: { connectionString: UNREACHABLE_DB },
    CLERK_WEBHOOK_SIGNING_SECRET: TEST_WEBHOOK_SECRET,
    ...overrides,
  };
}
