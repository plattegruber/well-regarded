// Loader/action tests for the Google location-mapping screen (#121), in
// the node environment (loaders/actions are server code). The mapping
// write + validation itself is integration-tested in packages/db
// (saveGoogleLocationMappings); here we assert the recipe around it:
// permission check, dynamic form interpretation (map/skip/create rows),
// 422 paths, the flash + redirect, the refresh proxy, and the loader's
// suggestion/decision wiring.
import type { StaffActor } from "@wellregarded/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSourceConnection = vi.hoisted(() => vi.fn());
const listPracticeLocations = vi.hoisted(() => vi.fn());
const saveGoogleLocationMappings = vi.hoisted(() => vi.fn());
const requirePracticeContext = vi.hoisted(() => vi.fn());

vi.mock("@wellregarded/db", () => ({
  getSourceConnection,
  listPracticeLocations,
  saveGoogleLocationMappings,
}));
vi.mock("~/lib/db.server", () => ({
  withRequestDb: (_context: unknown, fn: (db: unknown) => Promise<unknown>) =>
    fn({}),
}));
vi.mock("~/lib/practice-context.server", () => ({ requirePracticeContext }));

import { action, loader } from "./settings.integrations.google.locations";

const PRACTICE_ID = "0f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const STAFF_ID = "3f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const LOCATION_ID = "4f9619ff-8b86-4d01-b42d-00cf4fc964ff";

function practiceContext(role: StaffActor["role"]) {
  const actor: StaffActor = {
    type: "staff",
    staffId: STAFF_ID,
    practiceId: PRACTICE_ID,
    role,
    locationId: null,
  };
  return {
    practiceId: PRACTICE_ID,
    actor,
    auditActor: { type: "staff" as const, id: STAFF_ID },
    viewer: { viewPrivateFeedback: true, viewPatientIdentity: true },
  };
}

function discovered(overrides: Record<string, unknown> = {}) {
  return {
    googleLocationName: "locations/101",
    googleAccountName: "accounts/1",
    accountDisplayName: "Cedar Ridge Dental Group",
    title: "Cedar Ridge Dental — Downtown",
    address: "412 Cedar Ridge Ave, Suite 200, Grand Rapids, MI 49503",
    verificationState: "verified",
    discoveredAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function connection(metadata: Record<string, unknown>) {
  return { id: "conn-1", status: "active", metadata, lastSyncAt: null };
}

function args(fields: Record<string, string>, init: { url?: string } = {}) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    body.append(key, value);
  }
  const request = new Request(
    init.url ?? "http://localhost/settings/integrations/google/locations",
    { method: "POST", body },
  );
  return {
    request,
    params: {},
    context: {
      cloudflare: {
        env: {
          ENVIRONMENT: "local",
          API_URL: "http://api.test",
        } as unknown as Env,
        ctx: {} as ExecutionContext,
      },
      requestId: "test-request-id",
      // biome-ignore lint/suspicious/noExplicitAny: these paths never log
      logger: undefined as any,
    },
    // biome-ignore lint/suspicious/noExplicitAny: route arg typing is generated per-route; the test erases it
  } as any;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  requirePracticeContext.mockResolvedValue(practiceContext("owner"));
  listPracticeLocations.mockResolvedValue([]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("google locations loader", () => {
  it("returns connected:false without a connection", async () => {
    getSourceConnection.mockResolvedValue(null);
    const result = await loader(args({}));
    expect(result).toMatchObject({ connected: false });
  });

  it("pre-selects an unambiguous match, keeps saved decisions, disables unverified", async () => {
    getSourceConnection.mockResolvedValue(
      connection({
        googleLocations: [
          discovered(), // matches "Cedar Ridge Dental — Downtown" by name
          discovered({
            googleLocationName: "locations/102",
            title: "Cedar Ridge Dental — Westside",
            address: "",
          }),
          discovered({
            googleLocationName: "locations/103",
            title: "Old Listing",
            verificationState: "unverified",
          }),
        ],
        locationMappings: [
          {
            googleLocationName: "locations/102",
            locationId: null, // deliberately skipped
            mappedBy: STAFF_ID,
            mappedAt: "2026-07-02T00:00:00.000Z",
          },
        ],
      }),
    );
    listPracticeLocations.mockResolvedValue([
      {
        id: LOCATION_ID,
        name: "Cedar Ridge Dental — Downtown",
        addressLine1: "412 Cedar Ridge Ave",
      },
    ]);

    const result = await loader(args({}));
    if (!("rows" in result) || result.connected !== true) {
      throw new Error("expected connected loader data");
    }
    expect(result.multiAccount).toBe(false);
    expect(
      result.rows.map((r) => [r.googleLocationName, r.initialValue]),
    ).toEqual([
      ["locations/101", `map:${LOCATION_ID}`], // auto-suggested
      ["locations/102", "skip"], // saved decision wins
      ["locations/103", ""], // unverified: never suggested
    ]);
    expect(result.rows[0]?.suggested).toBe(true);
    expect(result.rows[2]?.verified).toBe(false);
    // Create-new prefill split from the formatted address.
    expect(result.rows[0]?.createDefaults).toEqual({
      name: "Cedar Ridge Dental — Downtown",
      addressLine1: "412 Cedar Ridge Ave, Suite 200",
      city: "Grand Rapids",
      state: "MI",
      postalCode: "49503",
    });
  });
});

describe("google locations save action", () => {
  it("interprets map/skip/create rows, saves, flashes, redirects", async () => {
    saveGoogleLocationMappings.mockResolvedValue({
      status: "saved",
      connection: connection({}),
      mappings: [],
      createdLocations: [],
    });
    const result = await action(
      args({
        intent: "save",
        "decision:locations/101": `map:${LOCATION_ID}`,
        "decision:locations/102": "skip",
        "decision:locations/103": "", // undecided — no entry
        "decision:locations/104": "create",
        "create:locations/104:name": "North Park",
        "create:locations/104:addressLine1": "2301 Plainfield Ave NE",
        "create:locations/104:city": "Grand Rapids",
        "create:locations/104:state": "MI",
        "create:locations/104:postalCode": "",
      }),
    );

    expect(saveGoogleLocationMappings).toHaveBeenCalledWith(expect.anything(), {
      practiceId: PRACTICE_ID,
      actor: { type: "staff", id: STAFF_ID },
      entries: [
        {
          googleLocationName: "locations/101",
          decision: { kind: "map", locationId: LOCATION_ID },
        },
        { googleLocationName: "locations/102", decision: { kind: "skip" } },
        {
          googleLocationName: "locations/104",
          decision: {
            kind: "create",
            name: "North Park",
            addressLine1: "2301 Plainfield Ave NE",
            city: "Grand Rapids",
            state: "MI",
            postalCode: null,
          },
        },
      ],
    });
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/settings/integrations/google/locations",
    );
    expect(response.headers.get("Set-Cookie")).toContain("__wr_flash");
  });

  it("403s for a role without manage_settings — nothing saved", async () => {
    requirePracticeContext.mockResolvedValue(practiceContext("front_desk"));
    await expect(
      action(args({ intent: "save", "decision:locations/101": "skip" })),
    ).rejects.toMatchObject({ init: { status: 403 } });
    expect(saveGoogleLocationMappings).not.toHaveBeenCalled();
  });

  it("422s a create row without a name — returned, never thrown", async () => {
    const result = await action(
      args({
        intent: "save",
        "decision:locations/104": "create",
        "create:locations/104:name": "   ",
      }),
    );
    expect(result).toMatchObject({
      init: { status: 422 },
      data: {
        fieldErrors: {
          "decision:locations/104": ["Enter a name for the new location."],
        },
      },
    });
    expect(saveGoogleLocationMappings).not.toHaveBeenCalled();
  });

  it("maps helper validation issues onto row field errors (422)", async () => {
    saveGoogleLocationMappings.mockResolvedValue({
      status: "invalid",
      issues: [
        {
          code: "unknown_google_location",
          googleLocationName: "locations/999",
          message: "locations/999 is not in the discovered snapshot.",
        },
      ],
    });
    const result = await action(
      args({ intent: "save", "decision:locations/999": "skip" }),
    );
    expect(result).toMatchObject({
      init: { status: 422 },
      data: {
        fieldErrors: {
          "decision:locations/999": [
            "locations/999 is not in the discovered snapshot.",
          ],
        },
      },
    });
  });
});

describe("google locations refresh action", () => {
  it("proxies to the API worker with the caller's cookie and redirects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const formArgs = args({ intent: "refresh" });
    formArgs.request.headers.set("cookie", "__session=jwt");
    const result = await action(formArgs);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/api/integrations/google/locations/discover",
      { method: "POST", headers: { cookie: "__session=jwt" } },
    );
    expect((result as Response).status).toBe(302);
  });

  it("surfaces reconnect guidance on 409 and a retry line on failure", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 409 })) as typeof fetch;
    const conflicted = await action(args({ intent: "refresh" }));
    expect(conflicted).toMatchObject({
      init: { status: 409 },
      data: { refreshError: expect.stringContaining("reconnect") },
    });

    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network")) as typeof fetch;
    const failed = await action(args({ intent: "refresh" }));
    expect(failed).toMatchObject({
      init: { status: 502 },
      data: { refreshError: expect.stringContaining("Try again") },
    });
  });
});
