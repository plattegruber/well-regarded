/**
 * `@wellregarded/sources/google/fake` — the fake Google Business Profile
 * server (issue #130, Epic #7).
 *
 * Test/dev infrastructure only: importable in-process for Vitest (mount
 * `app.fetch` as the injected fetch — see `app.ts` and README.md) and
 * runnable standalone for local dev (`pnpm dev:fake-gbp`, port 8799). It
 * ships in the repo but never deploys.
 *
 * Kept OFF the package's root entry on purpose: worker code imports
 * `@wellregarded/sources` and must never pull the fake (or Hono) into a
 * deploy bundle.
 */

export {
  createFakeGbp,
  FAKE_GBP_DEFAULT_PORT,
  type FakeGbp,
  GBP_OAUTH_SCOPE,
} from "./app.js";
export {
  GOOGLE_FIXTURE_SEED,
  renderGoogleFixtureFiles,
} from "./fixtureFiles.js";
export {
  FIXTURE_EPOCH,
  type FixturePractice,
  type GenerateFixturePracticeOptions,
  generateFixturePractice,
  mulberry32,
} from "./fixtures.js";
export {
  type AddLocationOverrides,
  type AddReviewOverrides,
  type EndpointMatcher,
  type FailNextOptions,
  FakeGbpStore,
  type FakeGbpStoreOptions,
} from "./store.js";
export * from "./types.js";
