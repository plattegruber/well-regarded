// Rendering tests for the review inbox (#76): empty vs zero-result states
// are distinct components, tabs carry counts, rows carry the status chip /
// sentiment chip / red response-risk marker, and pagination links appear.
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import Reviews, { type ReviewRow } from "./reviews";

function row(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    sourceLabel: "Google",
    age: "3d ago",
    excerpt: "Dr. Aldana took the time to explain everything.",
    rating: 5,
    locationName: null,
    providerName: null,
    status: "needs_response",
    sentiment: { label: "Positive", tone: "positive" },
    highResponseRisk: false,
    deletedAtSource: false,
    ...overrides,
  };
}

interface LoaderDataOverrides {
  rows?: ReviewRow[];
  filtered?: boolean;
  paginated?: boolean;
  nextCursor?: string | null;
  counts?: Partial<{
    total: number;
    needs_response: number;
    drafted: number;
    pending_approval: number;
    responded: number;
  }>;
  stats?: Partial<{
    responseRate: string;
    medianResponse: string;
    unresponded: string;
    unrespondedDelta: string | null;
    unrespondedTone: "positive" | "negative" | "neutral";
    trend: Array<{ month: string; rate: number | null }>;
    smallSample: boolean;
  }>;
}

function loaderData(overrides: LoaderDataOverrides = {}) {
  const rows = overrides.rows ?? [];
  return {
    surface: {
      overline: "Public reviews · response workspace",
      title: "Reviews",
      description: "Respond safely and promptly.",
    },
    rows,
    nextCursor: overrides.nextCursor ?? null,
    counts: {
      total: rows.length,
      needs_response: rows.length,
      drafted: 0,
      pending_approval: 0,
      responded: 0,
      ...overrides.counts,
    },
    filtered: overrides.filtered ?? false,
    paginated: overrides.paginated ?? false,
    sort: "attention" as const,
    values: {
      source: "" as const,
      status: "" as const,
      locationId: "",
      ratings: [] as number[],
      sentiment: "" as const,
    },
    locations: [] as Array<{ id: string; name: string }>,
    stats: {
      responseRate: "\u2014",
      medianResponse: "\u2014",
      unresponded: "0",
      unrespondedDelta: null,
      unrespondedTone: "neutral" as const,
      trend: [] as Array<{ month: string; rate: number | null }>,
      smallSample: true,
      ...overrides.stats,
    },
  };
}

function render(
  data: ReturnType<typeof loaderData>,
  path = "/reviews",
): string {
  const ReviewsAny = Reviews as (props: {
    loaderData: unknown;
  }) => React.ReactNode;
  const Stub = createRoutesStub([
    {
      path: "/reviews",
      Component: () => <ReviewsAny loaderData={data} />,
    },
  ]);
  return renderToString(<Stub initialEntries={[path]} />);
}

describe("review inbox rendering", () => {
  it("renders the onboarding empty state when the practice has no reviews", () => {
    const html = render(loaderData());
    expect(html).toContain('data-testid="empty-state"');
    expect(html).toContain("Connect Google");
    expect(html).toContain("Import a CSV");
    expect(html).toContain("/settings/integrations");
    expect(html).toContain("/settings/imports");
    // Tabs and filters are pointless with nothing to filter.
    expect(html).not.toContain('data-testid="review-tabs"');
    expect(html).not.toContain('data-testid="reviews-filters"');
  });

  it("renders the distinct zero-result state when filters match nothing", () => {
    const html = render(
      loaderData({ filtered: true, counts: { total: 12, needs_response: 12 } }),
      "/reviews?sentiment=negative",
    );
    expect(html).toContain('data-testid="zero-results"');
    expect(html).toContain("No reviews match");
    expect(html).not.toContain('data-testid="empty-state"');
    expect(html).toContain('data-testid="review-tabs"');
    expect(html).toContain("Clear filters");
  });

  it("renders counted tabs for all five statuses", () => {
    const html = render(
      loaderData({
        rows: [row()],
        counts: {
          total: 10,
          needs_response: 4,
          drafted: 3,
          pending_approval: 2,
          responded: 1,
        },
      }),
    );
    expect(html).toContain('data-testid="review-tabs"');
    for (const label of [
      "All",
      "Needs response",
      "Drafted",
      "Pending approval",
      "Responded",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain(">10<");
    expect(html).toContain(">4<");
  });

  it("renders rows with stars, excerpt link, age, and status chip", () => {
    const html = render(loaderData({ rows: [row()] }));
    expect(html).toContain('data-testid="review-row"');
    expect(html).toContain("5 of 5 stars");
    expect(html).toContain("explain everything");
    expect(html).toContain("3d ago");
    expect(html).toContain("Needs response");
    expect(html).toContain("Positive");
    expect(html).toContain("/reviews/6f9619ff-8b86-4d01-b42d-00cf4fc964ff");
  });

  it("marks high response risk with the red-outlined indicator", () => {
    const withRisk = render(
      loaderData({ rows: [row({ highResponseRisk: true, rating: 2 })] }),
    );
    expect(withRisk).toContain('data-testid="response-risk"');
    expect(withRisk).toContain("Response risk");

    const withoutRisk = render(loaderData({ rows: [row()] }));
    expect(withoutRisk).not.toContain('data-testid="response-risk"');
  });

  it("renders an unclassified row without a sentiment chip, honestly", () => {
    // The filter select legitimately offers "Positive"; the row itself
    // must not carry a positive-toned badge.
    const html = render(loaderData({ rows: [row({ sentiment: null })] }));
    expect(html).toContain('data-testid="review-row"');
    expect(html).not.toContain("bg-status-positive-bg");

    const classified = render(loaderData({ rows: [row()] }));
    expect(classified).toContain("bg-status-positive-bg");
  });

  it("renders pagination links from the cursor", () => {
    const html = render(
      loaderData({ rows: [row()], nextCursor: "abc", paginated: true }),
      "/reviews?cursor=prev",
    );
    expect(html).toContain("More reviews");
    expect(html).toContain("Back to the top");
    expect(html).toContain("cursor=abc");
  });
});
