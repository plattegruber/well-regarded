// Loader tests for the integrations page (#121): the Google card's state
// derivation from the connection row + metadata counts. Node environment —
// server code only.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSourceConnection = vi.hoisted(() => vi.fn());
const requirePracticeContext = vi.hoisted(() => vi.fn());

vi.mock("@wellregarded/db", () => ({ getSourceConnection }));
vi.mock("~/lib/db.server", () => ({
  withRequestDb: (_context: unknown, fn: (db: unknown) => Promise<unknown>) =>
    fn({}),
}));
vi.mock("~/lib/practice-context.server", () => ({ requirePracticeContext }));

import { callbackErrorMessage, loader } from "./settings.integrations";

function loaderArgs() {
  return {
    request: new Request("http://localhost/settings/integrations"),
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
      // biome-ignore lint/suspicious/noExplicitAny: the loader never logs
      logger: undefined as any,
    },
    // biome-ignore lint/suspicious/noExplicitAny: route arg typing is generated per-route; the test erases it
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePracticeContext.mockResolvedValue({
    practiceId: "0f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    actor: {},
    auditActor: { type: "staff", id: "x" },
    viewer: { viewPrivateFeedback: true, viewPatientIdentity: true },
  });
});

function discovered(verificationState: "verified" | "unverified") {
  return {
    googleLocationName: `locations/${Math.random()}`,
    googleAccountName: "accounts/1",
    accountDisplayName: "Cedar Ridge Dental Group",
    title: "Somewhere",
    address: "",
    verificationState,
    discoveredAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("integrations loader", () => {
  it("returns google:null when nothing is connected (or disconnected)", async () => {
    getSourceConnection.mockResolvedValue(null);
    expect(await loader(loaderArgs())).toEqual({
      apiUrl: "http://api.test",
      google: null,
    });

    getSourceConnection.mockResolvedValue({ status: "disconnected" });
    expect((await loader(loaderArgs())).google).toBeNull();
  });

  it("derives the card counts from the metadata", async () => {
    getSourceConnection.mockResolvedValue({
      status: "active",
      lastSyncAt: null,
      metadata: {
        googleLocations: [
          discovered("verified"),
          discovered("verified"),
          discovered("verified"),
          discovered("unverified"),
        ],
        locationMappings: [
          {
            googleLocationName: "locations/1",
            locationId: "11111111-1111-4111-8111-111111111111",
            mappedBy: null,
            mappedAt: "2026-07-02T00:00:00.000Z",
          },
          {
            googleLocationName: "locations/2",
            locationId: null,
            mappedBy: null,
            mappedAt: "2026-07-02T00:00:00.000Z",
          },
        ],
      },
    });
    expect((await loader(loaderArgs())).google).toEqual({
      status: "active",
      lastSyncAt: null,
      discovered: 4,
      unverified: 1,
      mapped: 1,
      skipped: 1,
    });
  });
});

describe("callbackErrorMessage", () => {
  it("maps known codes and falls back calmly for unknown ones", () => {
    expect(callbackErrorMessage("google_access_denied")).toContain("declined");
    expect(callbackErrorMessage("google_next_new_code")).toContain(
      "didn't complete",
    );
  });
});
