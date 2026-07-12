/**
 * `@wellregarded/sources/testing` — test-only exports.
 *
 * Split from the root entry because `describeAdapterContract` imports
 * `vitest`, which must never be bundled into a worker. Import this subpath
 * from `*.test.ts` files only; the root `@wellregarded/sources` entry stays
 * Workers-runtime clean.
 */

export type {
  AdapterContractFixture,
  AdapterContractFixtures,
} from "./contract/describeAdapterContract.js";
export {
  adapterContractChecks,
  describeAdapterContract,
} from "./contract/describeAdapterContract.js";
export type { FixtureArtifact } from "./contract/fixtureAdapter.js";
export {
  emptyFixtureArtifact,
  fixtureAdapter,
  fixtureArtifact,
} from "./contract/fixtureAdapter.js";
export {
  MANUAL_FIXTURE_PRACTICE_ID,
  manualEntryEmptyArtifact,
  manualEntryFullArtifact,
  manualEntryMinimalArtifact,
} from "./manual/fixtures.js";
export type { RecordedGet, StoredArtifact } from "./testing/inMemoryBucket.js";
export { InMemoryRawArtifactBucket } from "./testing/inMemoryBucket.js";
