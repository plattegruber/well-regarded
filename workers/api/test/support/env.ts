/**
 * Fake worker envs for `app.request(path, init, env)`. Bindings are
 * structural (see src/bindings.ts): tests inject a plain
 * `{ connectionString }` for HYPERDRIVE.
 *
 * `getEnv` caches its parse per isolate — tests that vary env values
 * between requests must call `resetEnvCache()` (from @wellregarded/core)
 * in a beforeEach.
 */

import { FakeKv } from "./fakeKv";
import { TEST_WEBHOOK_SECRET } from "./webhooks";

export interface TestEnv {
  ENVIRONMENT: string;
  HYPERDRIVE: { connectionString: string };
  OAUTH_STATE: FakeKv;
  [key: string]: unknown;
}

/**
 * For unit tests that must never touch a database: postgres-js connects
 * lazily, so a request that (correctly) performs no query never dials
 * this address.
 */
export const UNREACHABLE_DB =
  "postgres://nobody:nowhere@127.0.0.1:1/unreachable";

/**
 * Test-only state-signing secret for the Google OAuth flow (issue #118) —
 * base64 of >= 32 readable bytes, computed at runtime so no secret-shaped
 * literal ever sits in the repo. Never a real key.
 */
export const TEST_OAUTH_STATE_SECRET = btoa(
  "wellregarded-test-only-oauth-state-secret!!",
);

export function testEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  return {
    ENVIRONMENT: "local",
    HYPERDRIVE: { connectionString: UNREACHABLE_DB },
    OAUTH_STATE: new FakeKv(),
    CLERK_WEBHOOK_SIGNING_SECRET: TEST_WEBHOOK_SECRET,
    ...overrides,
  };
}
