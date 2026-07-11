import { describe, expect, it } from "vitest";

import { createFakeGbp } from "./app.js";
import type {
  GbpAccountsListResponse,
  GbpLocation,
  GbpLocationsListResponse,
} from "./types.js";

function setup() {
  const { app, store } = createFakeGbp();
  const token = store.issueAccessToken();
  const get = (path: string) =>
    app.request(path, { headers: { Authorization: `Bearer ${token}` } });
  return { app, store, get };
}

describe("bearer enforcement (shallow on purpose)", () => {
  it.each([
    ["no Authorization header", undefined],
    ["a token the fake never issued", "Bearer made-up-token"],
    ["a malformed header", "fake-access-token-1"],
  ])("rejects %s with a Google-style 401", async (_label, header) => {
    const { app } = createFakeGbp();
    const res = await app.request("/v1/accounts", {
      headers: header ? { Authorization: header } : {},
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { code: 401, status: "UNAUTHENTICATED" },
    });
  });

  it("guards the v4 surface too", async () => {
    const { app } = createFakeGbp();
    const res = await app.request("/v4/accounts/1/locations/1/reviews");
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/accounts", () => {
  it("returns {} for an empty store (proto3 omits empty fields)", async () => {
    const { get } = setup();
    const res = await get("/v1/accounts");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("pages with the real API's small cap: default and max pageSize 20", async () => {
    const { store, get } = setup();
    for (let i = 0; i < 45; i += 1) store.addAccount();

    // Requesting more than 20 still yields 20 — accounts.list max is 20.
    const first = (await (
      await get("/v1/accounts?pageSize=50")
    ).json()) as GbpAccountsListResponse;
    expect(first.accounts).toHaveLength(20);
    expect(first.nextPageToken).toBeDefined();

    const seen = [...(first.accounts ?? [])];
    let pageToken = first.nextPageToken;
    while (pageToken) {
      const page = (await (
        await get(`/v1/accounts?pageToken=${encodeURIComponent(pageToken)}`)
      ).json()) as GbpAccountsListResponse;
      seen.push(...(page.accounts ?? []));
      pageToken = page.nextPageToken;
    }
    expect(seen.map((a) => a.name)).toEqual(
      store.listAccounts().map((a) => a.name),
    );
  });
});

describe("GET /v1/accounts/{a}/locations", () => {
  it("requires readMask, like the real Business Information API", async () => {
    const { store, get } = setup();
    store.addAccount();
    const res = await get("/v1/accounts/1/locations");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: 400, status: "INVALID_ARGUMENT" },
    });
  });

  it("rejects unknown readMask fields loudly", async () => {
    const { store, get } = setup();
    store.addAccount();
    const res = await get("/v1/accounts/1/locations?readMask=name,notAField");
    expect(res.status).toBe(400);
  });

  it("applies the readMask; nested paths select the whole top-level field", async () => {
    const { store, get } = setup();
    store.addAccount();
    store.addLocation({
      title: "Cedar Ridge Dental — Downtown",
      websiteUri: "https://example.com",
      profile: { description: "Family dentistry." },
    });

    const res = await get(
      "/v1/accounts/1/locations?readMask=name,title,profile.description",
    );
    const body = (await res.json()) as GbpLocationsListResponse;
    expect(body.locations).toEqual([
      {
        name: "locations/1",
        title: "Cedar Ridge Dental — Downtown",
        profile: { description: "Family dentistry." },
      },
    ]);
  });

  it("readMask=* returns everything, scoped to the requested account", async () => {
    const { store, get } = setup();
    const a1 = store.addAccount();
    store.addLocation({ account: a1.name });
    const a2 = store.addAccount();
    store.addLocation({ account: a2.name });

    const body = (await (
      await get("/v1/accounts/1/locations?readMask=*")
    ).json()) as GbpLocationsListResponse;
    expect(body.locations).toHaveLength(1);
    expect(body.totalSize).toBe(1);
    expect(body.locations?.[0]?.name).toBe("locations/1");
    expect(body.locations?.[0]?.metadata?.hasVoiceOfMerchant).toBe(true);
  });

  it("pages with default 10 / max 100", async () => {
    const { store, get } = setup();
    store.addAccount();
    for (let i = 0; i < 12; i += 1) store.addLocation();

    const defaults = (await (
      await get("/v1/accounts/1/locations?readMask=name")
    ).json()) as GbpLocationsListResponse;
    expect(defaults.locations).toHaveLength(10);
    expect(defaults.totalSize).toBe(12);
    expect(defaults.nextPageToken).toBeDefined();

    const rest = (await (
      await get(
        `/v1/accounts/1/locations?readMask=name&pageToken=${encodeURIComponent(defaults.nextPageToken ?? "")}`,
      )
    ).json()) as GbpLocationsListResponse;
    expect(rest.locations).toHaveLength(2);
    expect(rest.nextPageToken).toBeUndefined();

    const clamped = (await (
      await get("/v1/accounts/1/locations?readMask=name&pageSize=500")
    ).json()) as GbpLocationsListResponse;
    expect(clamped.locations).toHaveLength(12);
  });
});

describe("GET /v1/locations/{l} and VoiceOfMerchantState", () => {
  it("serves a single location's profile fields for Presence (#156)", async () => {
    const { store, get } = setup();
    store.addAccount();
    store.addLocation({
      regularHours: {
        periods: [
          {
            openDay: "MONDAY",
            openTime: { hours: 8 },
            closeDay: "MONDAY",
            closeTime: { hours: 17 },
          },
        ],
      },
    });

    const res = await get("/v1/locations/1?readMask=name,regularHours");
    const body = (await res.json()) as GbpLocation;
    expect(body.regularHours?.periods).toHaveLength(1);

    expect((await get("/v1/locations/99?readMask=name")).status).toBe(404);
  });

  it("exposes verified status the way real GBP does (no verificationState string)", async () => {
    const { store, get } = setup();
    store.addAccount();
    store.addLocation({ verified: true });
    store.addLocation({ verified: false });

    const verified = (await (
      await get("/v1/locations/1/VoiceOfMerchantState")
    ).json()) as { hasVoiceOfMerchant?: boolean };
    expect(verified.hasVoiceOfMerchant).toBe(true);

    const unverified = (await (
      await get("/v1/locations/2/VoiceOfMerchantState")
    ).json()) as { hasVoiceOfMerchant?: boolean };
    expect(unverified.hasVoiceOfMerchant).toBe(false);

    // …and the same signal on the Business Information metadata flag.
    const body = (await (
      await get("/v1/accounts/1/locations?readMask=name,metadata")
    ).json()) as GbpLocationsListResponse;
    expect(body.locations?.map((l) => l.metadata?.hasVoiceOfMerchant)).toEqual([
      true,
      false,
    ]);
  });
});

describe("GET /v4/.../media (photo count for Presence)", () => {
  it("reports totalMediaItemCount from the store", async () => {
    const { store, get } = setup();
    store.addAccount();
    store.addLocation({ mediaItemCount: 7 });

    const body = (await (
      await get("/v4/accounts/1/locations/1/media")
    ).json()) as { totalMediaItemCount?: number; mediaItems?: unknown[] };
    expect(body.totalMediaItemCount).toBe(7);
    expect(body.mediaItems).toHaveLength(7);
  });

  it("returns {} when the location has no media", async () => {
    const { store, get } = setup();
    store.addAccount();
    store.addLocation();
    expect(
      await (await get("/v4/accounts/1/locations/1/media")).json(),
    ).toEqual({});
  });
});
