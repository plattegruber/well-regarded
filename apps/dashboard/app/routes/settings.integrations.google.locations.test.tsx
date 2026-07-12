// @vitest-environment happy-dom
// Render tests for the mapping screen (#121) through a routes stub with
// the real loader (DB mocked): the unverified badge + disabled select, the
// auto-suggest pre-selection, the inline create panel, and the
// duplicate-mapping note. Server-only recipe tests live in
// settings.integrations.google.locations.action.test.ts.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSourceConnection = vi.hoisted(() => vi.fn());
const listPracticeLocations = vi.hoisted(() => vi.fn());

vi.mock("@wellregarded/db", () => ({
  getSourceConnection,
  listPracticeLocations,
  saveGoogleLocationMappings: vi.fn(),
}));
vi.mock("~/lib/db.server", () => ({
  withRequestDb: (_context: unknown, fn: (db: unknown) => Promise<unknown>) =>
    fn({}),
}));
vi.mock("~/lib/practice-context.server", () => ({
  requirePracticeContext: vi.fn().mockResolvedValue({
    practiceId: "0f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    actor: {
      type: "staff",
      staffId: "3f9619ff-8b86-4d01-b42d-00cf4fc964ff",
      practiceId: "0f9619ff-8b86-4d01-b42d-00cf4fc964ff",
      role: "owner",
      locationId: null,
    },
    auditActor: { type: "staff", id: "3f9619ff-8b86-4d01-b42d-00cf4fc964ff" },
    viewer: { viewPrivateFeedback: true, viewPatientIdentity: true },
  }),
}));

import GoogleLocations, {
  loader,
} from "./settings.integrations.google.locations";

const DOWNTOWN_ID = "11111111-1111-4111-8111-111111111111";
const WESTSIDE_ID = "22222222-2222-4222-8222-222222222222";

function discovered(overrides: Record<string, unknown> = {}) {
  return {
    googleLocationName: "locations/101",
    googleAccountName: "accounts/1",
    accountDisplayName: "Cedar Ridge Dental Group",
    title: "Cedar Ridge Dental — Downtown",
    address: "412 Cedar Ridge Ave, Grand Rapids, MI 49503",
    verificationState: "verified",
    discoveredAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  getSourceConnection.mockResolvedValue({
    id: "conn-1",
    status: "active",
    lastSyncAt: null,
    metadata: {
      googleLocations: [
        discovered(),
        discovered({
          googleLocationName: "locations/103",
          title: "Old Listing",
          address: "",
          verificationState: "unverified",
        }),
      ],
      locationMappings: [],
    },
  });
  listPracticeLocations.mockResolvedValue([
    {
      id: DOWNTOWN_ID,
      name: "Cedar Ridge Dental — Downtown",
      addressLine1: "412 Cedar Ridge Ave",
    },
    { id: WESTSIDE_ID, name: "Westside", addressLine1: null },
  ]);
});

afterEach(cleanup);

function renderPage() {
  const Stub = createRoutesStub(
    [
      {
        path: "/settings/integrations/google/locations",
        // biome-ignore lint/suspicious/noExplicitAny: the stub's own props satisfy the generated route props at runtime
        Component: GoogleLocations as any,
        HydrateFallback: () => null,
        loader,
      },
    ],
    {
      cloudflare: {
        env: {
          ENVIRONMENT: "local",
          API_URL: "http://api.test",
        } as unknown as Env,
        ctx: {} as ExecutionContext,
      },
      // biome-ignore lint/suspicious/noExplicitAny: partial context is enough here
    } as any,
  );
  return render(
    <Stub initialEntries={["/settings/integrations/google/locations"]} />,
  );
}

describe("google locations mapping screen", () => {
  it("renders rows with the unverified badge, disabled select, and explanation", async () => {
    renderPage();
    expect(await screen.findByText("Unverified on Google")).toBeTruthy();
    const unverifiedSelect = screen.getByLabelText(
      "Import decision for Old Listing",
    ) as unknown as HTMLSelectElement;
    expect(unverifiedSelect.disabled).toBe(true);
    expect(
      screen.getByText(/doesn't share reviews for unverified/),
    ).toBeTruthy();
  });

  it("pre-selects the suggested match and labels it", async () => {
    renderPage();
    const select = (await screen.findByLabelText(
      "Import decision for Cedar Ridge Dental — Downtown",
    )) as unknown as HTMLSelectElement;
    expect(select.value).toBe(`map:${DOWNTOWN_ID}`);
    expect(screen.getByText("Suggested match.")).toBeTruthy();
  });

  it("shows the inline create fields, prefilled, when Create new is chosen", async () => {
    renderPage();
    const select = await screen.findByLabelText(
      "Import decision for Cedar Ridge Dental — Downtown",
    );
    await userEvent.selectOptions(select, "create");
    const name = screen.getByLabelText("New location name") as HTMLInputElement;
    expect(name.value).toBe("Cedar Ridge Dental — Downtown");
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe(
      "412 Cedar Ridge Ave",
    );
  });
});
