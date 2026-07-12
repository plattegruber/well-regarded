import { describe, expect, it } from "vitest";

import {
  type GoogleDiscoveredLocation,
  googleV4LocationName,
  normalizeForMatching,
  parseGoogleConnectionMetadata,
  splitFormattedAddress,
  suggestLocationId,
} from "./googleLocations.js";

const DISCOVERED: GoogleDiscoveredLocation = {
  googleLocationName: "locations/101",
  googleAccountName: "accounts/1",
  accountDisplayName: "Cedar Ridge Dental Group",
  title: "Cedar Ridge Dental — Downtown",
  address: "412 Cedar Ridge Ave, Suite 200, Grand Rapids, MI 49503",
  verificationState: "verified",
  discoveredAt: "2026-07-01T00:00:00.000Z",
};

describe("normalizeForMatching", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeForMatching("Cedar Ridge Dental — Downtown!")).toBe(
      "cedar ridge dental downtown",
    );
  });

  it("drops suite/unit designators with their token", () => {
    expect(normalizeForMatching("412 Cedar Ridge Ave, Suite 200")).toBe(
      "412 cedar ridge ave",
    );
    expect(normalizeForMatching("88 Lakeshore Dr Ste. 4B")).toBe(
      "88 lakeshore dr",
    );
    expect(normalizeForMatching("2301 Plainfield Ave # 12")).toBe(
      "2301 plainfield ave",
    );
  });
});

describe("suggestLocationId", () => {
  const downtown = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Cedar Ridge Dental — Downtown",
    addressLine1: "412 Cedar Ridge Ave, Suite 200",
  };
  const westside = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Westside",
    addressLine1: "88 Lakeshore Dr",
  };

  it("suggests on an unambiguous name match", () => {
    expect(suggestLocationId(DISCOVERED, [downtown, westside])).toBe(
      downtown.id,
    );
  });

  it("suggests on an unambiguous first-address-line match", () => {
    const renamed = { ...downtown, name: "Main Office" };
    expect(suggestLocationId(DISCOVERED, [renamed, westside])).toBe(renamed.id);
  });

  it("returns null when two candidates match (ambiguous)", () => {
    const twin = { ...downtown, id: "33333333-3333-4333-8333-333333333333" };
    expect(suggestLocationId(DISCOVERED, [downtown, twin])).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(suggestLocationId(DISCOVERED, [westside])).toBeNull();
  });

  it("never matches on empty strings", () => {
    const blank = { ...DISCOVERED, title: "—", address: "" };
    const emptyish = { id: "id-1", name: "?", addressLine1: null };
    expect(suggestLocationId(blank, [emptyish])).toBeNull();
  });
});

describe("parseGoogleConnectionMetadata", () => {
  it("reads both arrays and tolerates extra keys", () => {
    const metadata = {
      googleLocations: [DISCOVERED],
      locationMappings: [
        {
          googleLocationName: "locations/101",
          locationId: null,
          mappedBy: null,
          mappedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
      syncCursors: { "locations/101": "2026-07-01T00:00:00.000Z" }, // #123's key
    };
    const parsed = parseGoogleConnectionMetadata(metadata);
    expect(parsed.googleLocations).toEqual([DISCOVERED]);
    expect(parsed.locationMappings).toHaveLength(1);
  });

  it.each([
    null,
    undefined,
    {},
    { googleLocations: "nope" },
    42,
  ])("reads %j as empty", (metadata) => {
    expect(parseGoogleConnectionMetadata(metadata)).toEqual({
      googleLocations: [],
      locationMappings: [],
    });
  });
});

describe("googleV4LocationName", () => {
  it("joins the account and location resource names", () => {
    expect(googleV4LocationName("accounts/1", "locations/101")).toBe(
      "accounts/1/locations/101",
    );
  });
});

describe("splitFormattedAddress", () => {
  it("splits the discovery format back into location fields", () => {
    expect(
      splitFormattedAddress(
        "412 Cedar Ridge Ave, Suite 200, Grand Rapids, MI 49503",
      ),
    ).toEqual({
      addressLine1: "412 Cedar Ridge Ave, Suite 200",
      city: "Grand Rapids",
      state: "MI",
      postalCode: "49503",
    });
  });

  it("handles short and empty addresses without inventing fields", () => {
    expect(splitFormattedAddress("88 Lakeshore Dr")).toEqual({
      addressLine1: "88 Lakeshore Dr",
      city: null,
      state: null,
      postalCode: null,
    });
    expect(splitFormattedAddress("")).toEqual({
      addressLine1: null,
      city: null,
      state: null,
      postalCode: null,
    });
  });
});
