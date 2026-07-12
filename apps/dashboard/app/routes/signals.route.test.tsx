// Rendering tests for the signals inbox (#88): empty vs zero-result states
// are distinct components, rows carry the visibility badge and consent
// line, and a redacted patient renders as "Patient (hidden)" — the name
// itself never reaches the component (enforced in packages/db; asserted
// there too).
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import { SURFACES } from "~/lib/surfaces";
import Signals, { type SignalRow } from "./signals";

function row(overrides: Partial<SignalRow> = {}): SignalRow {
  return {
    id: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    sourceLabel: "Google",
    visibility: "public",
    age: "3d ago",
    text: "Dr. Aldana took the time to explain everything.",
    rating: 5,
    patientLabel: null,
    locationName: null,
    providerName: null,
    sentiment: { label: "Positive", tone: "positive" },
    urgency: null,
    suspectedDuplicate: false,
    edited: false,
    deletedAtSource: false,
    consent: {
      summary: "No consent recorded — not publishable",
      status: "none",
    },
    ...overrides,
  };
}

interface LoaderDataOverrides {
  rows?: SignalRow[];
  filtered?: boolean;
  paginated?: boolean;
  nextCursor?: string | null;
}

function loaderData(overrides: LoaderDataOverrides = {}) {
  return {
    surface: SURFACES.signals,
    rows: overrides.rows ?? [],
    nextCursor: overrides.nextCursor ?? null,
    filtered: overrides.filtered ?? false,
    paginated: overrides.paginated ?? false,
    filterValues: {
      sourceKind: "",
      visibility: "",
      sentiment: "",
      urgency: "",
      locationId: "",
      providerId: "",
      suspectedDuplicate: false,
      q: "",
    },
    options: { locations: [], providers: [] },
  };
}

function render(
  data: ReturnType<typeof loaderData>,
  path = "/signals",
): string {
  const SignalsAny = Signals as (props: {
    loaderData: unknown;
  }) => React.ReactNode;
  const Stub = createRoutesStub([
    {
      path: "/signals",
      Component: () => <SignalsAny loaderData={data} />,
    },
  ]);
  return renderToString(<Stub initialEntries={[path]} />);
}

describe("signals inbox rendering", () => {
  it("renders the no-signals-yet empty state when unfiltered and empty", () => {
    const html = render(loaderData());
    expect(html).toContain('data-testid="empty-state"');
    expect(html).toContain("No signals yet");
    // The filter bar is pointless with nothing to filter.
    expect(html).not.toContain('data-testid="signals-filters"');
  });

  it("renders the distinct zero-result state when filters match nothing", () => {
    const html = render(loaderData({ filtered: true }), "/signals?q=zzz");
    expect(html).toContain('data-testid="zero-results"');
    expect(html).toContain("Nothing matches");
    expect(html).not.toContain('data-testid="empty-state"');
    expect(html).toContain('data-testid="signals-filters"');
  });

  it("renders rows with source, visibility badge, text, and rights", () => {
    const html = render(loaderData({ rows: [row()] }));
    expect(html).toContain('data-testid="signal-row"');
    expect(html).toContain("Google");
    expect(html).toContain('data-visibility="public"');
    expect(html).toContain("explain everything");
    expect(html).toContain("Positive");
    expect(html).toContain("No consent recorded — not publishable");
    expect(html).toContain("/signals/6f9619ff-8b86-4d01-b42d-00cf4fc964ff");
  });

  it("renders private rows loudly, with the redacted patient label", () => {
    const html = render(
      loaderData({
        rows: [
          row({
            visibility: "private",
            patientLabel: "Patient (hidden)",
            sourceLabel: "Post-visit",
          }),
        ],
      }),
    );
    expect(html).toContain('data-visibility="private"');
    expect(html).toContain("Patient (hidden)");
  });

  it("marks inferred urgency and suspected duplicates on the row", () => {
    const html = render(
      loaderData({
        rows: [
          row({
            urgency: { label: "High urgency", basis: "inferred_related" },
            suspectedDuplicate: true,
          }),
        ],
      }),
    );
    // SSR inserts a comment node between the text parts; match both.
    expect(html).toContain("High urgency");
    expect(html).toContain("· inferred");
    expect(html).toContain("Possible duplicate");
  });

  it("offers older/newer navigation from the cursor state", () => {
    const withNext = render(loaderData({ rows: [row()], nextCursor: "abc" }));
    expect(withNext).toContain("Older signals");
    expect(withNext).toContain("cursor=abc");
    expect(withNext).not.toContain("Back to latest");

    const pastPageOne = render(
      loaderData({ rows: [row()], paginated: true }),
      "/signals?cursor=abc",
    );
    expect(pastPageOne).toContain("Back to latest");
  });
});
