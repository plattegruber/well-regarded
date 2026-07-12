// Rendering tests for the review detail (#77): inferred attribution never
// renders bare, unclassified dimensions say so, no raw confidence float
// reaches the page, and the response thread renders its honest empty
// state with the composer seam intact.
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import ReviewDetail from "./reviews.$signalId";

type DerivationView = {
  dimension: string;
  label: string;
  value: string | null;
  basis: string | null;
  confidence: number | null;
  rationale: string | null;
  judgedOn: string | null;
};

function derivation(overrides: Partial<DerivationView> = {}): DerivationView {
  return {
    dimension: "sentiment",
    label: "Sentiment",
    value: "Negative",
    basis: "inferred_text",
    confidence: 0.82,
    rationale: "The reviewer describes an unresolved billing concern.",
    judgedOn: "July 1, 2026",
    ...overrides,
  };
}

function loaderData(overrides: Record<string, unknown> = {}) {
  return {
    title: "Google review",
    overline: "Public review · Google",
    occurredOn: "July 4, 2026",
    status: "needs_response" as const,
    review: {
      originalText:
        "I was charged for something my insurance was supposed to cover.",
      rating: 2,
      sourceUrl: "https://maps.google.com/review/1",
      deletedAtSource: false,
      edited: false,
      currentText: null,
    },
    attribution: {
      location: { name: "Main Street", hint: null },
      provider: {
        name: null,
        hint: { text: "Dr. Patel", basis: "inferred_text" as const },
      },
    },
    derivations: [
      derivation(),
      derivation({
        dimension: "urgency",
        label: "Urgency",
        value: null,
        basis: null,
        confidence: null,
        rationale: null,
        judgedOn: null,
      }),
      derivation({
        dimension: "response_risk",
        label: "Response risk",
        value: "High",
        confidence: 0.91,
        rationale: "A reply could confirm billing details in public.",
      }),
    ],
    publicationSuitability: derivation({
      dimension: "publication_suitability",
      label: "Publication suitability",
      value: "Unsuitable",
      confidence: 0.77,
      rationale: null,
    }),
    highResponseRisk: true,
    responses: [],
    responseSourceNote:
      "Replies posted directly on Google are not captured yet. This thread shows responses recorded in Well Regarded.",
    // The workflow seam (#80/#82): no response yet → no panel renders.
    workflow: {
      latest: null,
      canDraft: true,
      canApprove: true,
      reviewIsNegative: true,
      action: "/reviews/8b0d3f8e-0000-4000-8000-000000000000/responses",
    },
    // The composer seam (#79): null = nothing to draft (or no permission).
    composer: null as null | {
      draft: null;
      templates: Array<{
        id: string;
        name: string;
        tone: string;
        body: string;
      }>;
      reviewerName: null;
      practiceName: string;
    },
    ...overrides,
  };
}

function render(data: ReturnType<typeof loaderData>): string {
  const DetailAny = ReviewDetail as (props: {
    loaderData: unknown;
  }) => React.ReactNode;
  const Stub = createRoutesStub([
    {
      path: "/reviews/:signalId",
      Component: () => <DetailAny loaderData={data} />,
    },
  ]);
  return renderToString(
    <Stub initialEntries={["/reviews/6f9619ff-8b86-4d01-b42d-00cf4fc964ff"]} />,
  );
}

describe("review detail rendering", () => {
  it("renders the full review with rating, date, and source link", () => {
    const html = render(loaderData());
    expect(html).toContain('data-testid="review-text"');
    expect(html).toContain("insurance was supposed to cover");
    expect(html).toContain("2 of 5 stars");
    expect(html).toContain("July 4, 2026");
    expect(html).toContain("https://maps.google.com/review/1");
    expect(html).toContain("View at source");
  });

  it("renders inferred attribution as 'likely …' with a basis badge, never bare", () => {
    const html = render(loaderData());
    expect(html).toContain("likely Dr. Patel");
    expect(html).toContain('data-basis="inferred_text"');
    // The confirmed location renders plainly.
    expect(html).toContain("Main Street");
    expect(html).not.toContain("likely Main Street");
  });

  it("renders derivations with plain-language confidence and no raw floats", () => {
    const html = render(loaderData());
    expect(html).toContain("Negative");
    expect(html).toContain("confidence");
    expect(html).toContain("unresolved billing concern");
    // Ethical invariant: raw confidence floats never reach the page —
    // checked over the text content (class names legitimately contain
    // fractional spacing values).
    const text = html.replace(/<[^>]*>/g, " ");
    expect(text).not.toMatch(/0\.\d/);
  });

  it("says 'Not yet classified' for absent dimensions — no fake neutrals", () => {
    const html = render(loaderData());
    expect(html).toContain("Not yet classified");
  });

  it("keeps publication suitability behind the disclosure", () => {
    const html = render(loaderData());
    expect(html).toContain("<details");
    expect(html).toContain("Publication suitability");
  });

  it("shows the red response-risk indicator only when risk is high", () => {
    expect(render(loaderData())).toContain('data-testid="response-risk"');
    expect(render(loaderData({ highResponseRisk: false }))).not.toContain(
      'data-testid="response-risk"',
    );
  });

  it("renders the response thread's honest empty state with the Google note", () => {
    const html = render(loaderData());
    expect(html).toContain('data-testid="response-thread"');
    expect(html).toContain("No response recorded yet");
    expect(html).toContain("not captured yet");
  });

  it("mounts the composer in the thread slot when there's something to draft", () => {
    const html = render(
      loaderData({
        composer: {
          draft: null,
          templates: [
            {
              id: "11111111-0000-4000-8000-000000000001",
              name: "Positive review",
              tone: "warm",
              body: "Thanks, {reviewer_name}.",
            },
          ],
          reviewerName: null,
          practiceName: "Cedar Ridge Dental",
        },
      }),
    );
    expect(html).toContain('data-testid="response-composer"');
    expect(html).toContain("Draft with AI");
    expect(html).toContain("Positive review · warm");
    // Static tone hint (#79 req 6) rendered with the field.
    expect(html).toContain("confirm they were a patient");
  });

  it("keeps the composer out for viewers without draft rights (composer: null)", () => {
    const html = render(loaderData());
    expect(html).not.toContain('data-testid="response-composer"');
  });

  it("renders the deleted-at-source notice when set", () => {
    const html = render(
      loaderData({
        review: {
          originalText: "Gone from Google.",
          rating: null,
          sourceUrl: null,
          deletedAtSource: true,
          edited: false,
          currentText: null,
        },
      }),
    );
    expect(html).toContain('data-testid="deleted-notice"');
    expect(html).toContain("deleted at the source");
  });
});
