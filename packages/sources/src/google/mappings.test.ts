import type {
  GoogleDiscoveredLocation,
  GoogleLocationMapping,
} from "@wellregarded/core";
import { describe, expect, it } from "vitest";

import { getActiveMappings } from "./mappings.js";

const LOCATION_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_ID = "22222222-2222-4222-8222-222222222222";

function discovered(
  overrides: Partial<GoogleDiscoveredLocation> = {},
): GoogleDiscoveredLocation {
  return {
    googleLocationName: "locations/101",
    googleAccountName: "accounts/1",
    accountDisplayName: "Cedar Ridge Dental Group",
    title: "Downtown",
    address: "412 Cedar Ridge Ave, Grand Rapids, MI 49503",
    verificationState: "verified",
    discoveredAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function mapping(
  overrides: Partial<GoogleLocationMapping> = {},
): GoogleLocationMapping {
  return {
    googleLocationName: "locations/101",
    locationId: LOCATION_ID,
    mappedBy: STAFF_ID,
    mappedAt: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("getActiveMappings", () => {
  it("returns mapped, verified locations with the composed v4 name", () => {
    const result = getActiveMappings({
      metadata: {
        googleLocations: [discovered()],
        locationMappings: [mapping()],
      },
    });
    expect(result.active).toEqual([
      {
        googleLocationName: "locations/101",
        googleAccountName: "accounts/1",
        v4LocationName: "accounts/1/locations/101",
        locationId: LOCATION_ID,
      },
    ]);
    expect(result.excluded).toEqual([]);
  });

  it("excludes unmapped, skipped, and unverified locations with reasons", () => {
    const result = getActiveMappings({
      metadata: {
        googleLocations: [
          discovered({ googleLocationName: "locations/101" }),
          discovered({ googleLocationName: "locations/102" }),
          discovered({
            googleLocationName: "locations/103",
            verificationState: "unverified",
          }),
          discovered({ googleLocationName: "locations/104" }),
        ],
        locationMappings: [
          mapping({ googleLocationName: "locations/101" }),
          mapping({ googleLocationName: "locations/102", locationId: null }),
          // 103 mapped despite being unverified (bad old data): still excluded.
          mapping({ googleLocationName: "locations/103" }),
          // 104 has no mapping entry at all.
        ],
      },
    });
    expect(result.active.map((a) => a.googleLocationName)).toEqual([
      "locations/101",
    ]);
    expect(result.excluded).toEqual([
      { googleLocationName: "locations/102", reason: "skipped" },
      { googleLocationName: "locations/103", reason: "unverified" },
      { googleLocationName: "locations/104", reason: "unmapped" },
    ]);
  });

  it("excludes mappings whose location left the snapshot", () => {
    const result = getActiveMappings({
      metadata: {
        googleLocations: [],
        locationMappings: [mapping({ googleLocationName: "locations/999" })],
      },
    });
    expect(result.active).toEqual([]);
    expect(result.excluded).toEqual([
      { googleLocationName: "locations/999", reason: "not_in_snapshot" },
    ]);
  });

  it("reads absent or malformed metadata as nothing to poll", () => {
    expect(getActiveMappings({ metadata: {} })).toEqual({
      active: [],
      excluded: [],
    });
    expect(getActiveMappings({ metadata: null })).toEqual({
      active: [],
      excluded: [],
    });
  });
});
