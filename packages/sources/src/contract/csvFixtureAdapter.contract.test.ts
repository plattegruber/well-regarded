/**
 * The CSV reference adapter proves itself against the shared contract suite
 * like every real adapter must (issue #101/#104).
 */

import { describe, expect, it } from "vitest";

import {
  csvFixtureAdapter,
  csvFixtureArtifact,
  emptyCsvFixtureArtifact,
} from "./csvFixtureAdapter.js";
import { describeAdapterContract } from "./describeAdapterContract.js";

describeAdapterContract(csvFixtureAdapter, {
  valid: [
    {
      name: "a legacy feedback export chunk",
      artifact: csvFixtureArtifact,
      expectedCount: 2,
    },
  ],
  empty: emptyCsvFixtureArtifact,
});

describe("csvFixtureAdapter specifics", () => {
  it("maps contact columns to a patientHint and columns to source_metadata hints", async () => {
    const [first, second] =
      await csvFixtureAdapter.normalize(csvFixtureArtifact);
    expect(first?.patientHint).toEqual({
      name: "R. Alvarez",
      email: "r.alvarez@example.com",
    });
    expect(first?.providerHint).toEqual({
      text: "Dr. Patel",
      basis: "source_metadata",
    });
    expect(first?.consentHint).toBe("imported_unknown");
    expect(second?.patientHint).toBeUndefined();
  });

  it("rejects an artifact of the wrong shape", async () => {
    await expect(csvFixtureAdapter.normalize({ nope: 1 })).rejects.toThrow(
      "not a CsvFixtureArtifact",
    );
  });
});
