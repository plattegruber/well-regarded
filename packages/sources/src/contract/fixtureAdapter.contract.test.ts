/**
 * The reference adapter run through the shared contract suite — exactly how
 * every real adapter's test file (Epic #7/#8) will invoke it. This proves
 * `describeAdapterContract` registers and passes in CI before any real
 * adapter exists (issue #101, requirement 5).
 */

import { describeAdapterContract } from "./describeAdapterContract.js";
import {
  emptyFixtureArtifact,
  fixtureAdapter,
  fixtureArtifact,
} from "./fixtureAdapter.js";

describeAdapterContract(fixtureAdapter, {
  valid: [
    {
      name: "a batch of three entries",
      artifact: fixtureArtifact,
      expectedCount: 3,
    },
    {
      name: "a single rating-only entry",
      artifact: {
        entries: [{ id: "solo-1", when: "2026-04-01T10:00:00Z", rating: 5 }],
      },
      expectedCount: 1,
    },
  ],
  empty: emptyFixtureArtifact,
});
