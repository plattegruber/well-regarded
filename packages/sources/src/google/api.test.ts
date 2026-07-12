/**
 * Discovery client tests (issue #121) against the fake GBP server (#130),
 * injected as the `fetch` implementation — no server, no port. The fake
 * enforces the real API's quirks (accounts pages max 20, `readMask`
 * required, bearer enforcement), so these tests prove the client speaks
 * them.
 */

import { describe, expect, it } from "vitest";
import {
  discoverGoogleLocations,
  GoogleApiError,
  type GoogleDataApiConfig,
  listAccounts,
  listLocations,
} from "./api.js";
import { createFakeGbp } from "./fake/index.js";

function setup() {
  const { app, store } = createFakeGbp();
  const code = store.issueAuthCode({ withRefreshToken: true });
  const granted = store.exchangeAuthCode(code, {});
  if (!granted) throw new Error("fake exchange failed");
  const config: GoogleDataApiConfig = {
    accountManagementUrl: "https://mybusinessaccountmanagement.googleapis.com",
    businessInformationUrl:
      "https://mybusinessbusinessinformation.googleapis.com",
    accessToken: granted.accessToken,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
      app.fetch(new Request(input, init))) as typeof fetch,
  };
  return { store, config };
}

describe("listAccounts", () => {
  it("walks pagination (pages of 20) and returns every account", async () => {
    const { store, config } = setup();
    for (let i = 0; i < 23; i += 1) {
      store.addAccount({ accountName: `Account ${i}` });
    }
    const accounts = await listAccounts(config);
    expect(accounts).toHaveLength(23);
    expect(new Set(accounts.map((a) => a.name)).size).toBe(23);
  });

  it("throws GoogleApiError with Google's status on 401", async () => {
    const { config } = setup();
    const error = await listAccounts({
      ...config,
      accessToken: "not-a-token",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect((error as GoogleApiError).status).toBe(401);
    expect((error as GoogleApiError).googleStatus).toBe("UNAUTHENTICATED");
  });
});

describe("listLocations", () => {
  it("passes the required readMask and walks pagination", async () => {
    const { store, config } = setup();
    const account = store.addAccount();
    for (let i = 0; i < 105; i += 1) {
      store.addLocation({ account: account.name, title: `Location ${i}` });
    }
    const locations = await listLocations(config, account.name);
    expect(locations).toHaveLength(105);
    // The readMask asked for metadata — the verified flag came through.
    expect(locations[0]?.metadata?.hasVoiceOfMerchant).toBe(true);
  });
});

describe("discoverGoogleLocations", () => {
  it("flattens multi-account setups, annotating each location's account", async () => {
    const { store, config } = setup();
    const agency = store.addAccount({ accountName: "Smile Agency" });
    store.addLocation({ account: agency.name, title: "Client A" });
    const own = store.addAccount({ accountName: "Cedar Ridge Dental Group" });
    store.addLocation({ account: own.name, title: "Downtown" });
    store.addLocation({ account: own.name, title: "Westside" });

    const discovered = await discoverGoogleLocations(
      config,
      () => new Date("2026-07-01T00:00:00.000Z"),
    );
    expect(discovered).toHaveLength(3);
    expect(discovered.map((d) => d.accountDisplayName)).toEqual([
      "Smile Agency",
      "Cedar Ridge Dental Group",
      "Cedar Ridge Dental Group",
    ]);
    for (const entry of discovered) {
      expect(entry.googleLocationName).toMatch(/^locations\/\d+$/);
      expect(entry.googleAccountName).toMatch(/^accounts\/\d+$/);
      expect(entry.discoveredAt).toBe("2026-07-01T00:00:00.000Z");
    }
  });

  it("maps hasVoiceOfMerchant to the verification state", async () => {
    const { store, config } = setup();
    const account = store.addAccount();
    store.addLocation({ account: account.name, title: "Verified" });
    store.addLocation({
      account: account.name,
      title: "Unverified",
      verified: false,
    });

    const discovered = await discoverGoogleLocations(config);
    expect(discovered.map((d) => [d.title, d.verificationState])).toEqual([
      ["Verified", "verified"],
      ["Unverified", "unverified"],
    ]);
  });

  it("formats the storefront address as a single line", async () => {
    const { store, config } = setup();
    const account = store.addAccount();
    store.addLocation({
      account: account.name,
      title: "Downtown",
      storefrontAddress: {
        regionCode: "US",
        postalCode: "49503",
        administrativeArea: "MI",
        locality: "Grand Rapids",
        addressLines: ["412 Cedar Ridge Ave", "Suite 200"],
      },
    });
    store.addLocation({ account: account.name, title: "No address" });

    const discovered = await discoverGoogleLocations(config);
    expect(discovered[0]?.address).toBe(
      "412 Cedar Ridge Ave, Suite 200, Grand Rapids, MI 49503",
    );
    expect(discovered[1]?.address).toBe("");
  });
});
