// Today's rendering (#95): cards in loader order, each a single link, and
// the all-clear state — the warm empty message and NOTHING else on the
// page. No charts, no stats tiles, no placeholder widgets; asserting
// their absence is a requirement, not paranoia.
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import type { TodaySectionData } from "~/components/today/today-card";
import Today from "./today";

function renderToday(sections: TodaySectionData[]): string {
  const loaderData = { overline: "Friday, July 10", sections };
  // biome-ignore lint/suspicious/noExplicitAny: route prop types are generated per-route; the test erases them
  const TodayAny = Today as any;
  const Stub = createRoutesStub([
    {
      path: "/today",
      Component: () => <TodayAny loaderData={loaderData} />,
    },
  ]);
  return renderToString(<Stub initialEntries={["/today"]} />);
}

const SECTIONS: TodaySectionData[] = [
  {
    key: "reauth",
    cards: [
      {
        id: "conn-1",
        tag: "Connection",
        tone: "negative",
        title: "Google connection needs re-authorization",
        meta: "Polling paused until you reconnect",
        cta: "Reconnect",
        to: "/settings/integrations",
      },
    ],
    more: null,
  },
  {
    key: "negative-reviews",
    cards: [
      {
        id: "rev-1",
        tag: "2-star review",
        tone: "caution",
        title: "Waited an hour past my appointment time.",
        meta: "Google · waiting 20d ago",
        cta: "Respond",
        to: "/reviews/rev-1",
      },
    ],
    more: { count: 3, to: "/reviews" },
  },
];

describe("Today route", () => {
  it("renders cards in section order, each one action linking out", () => {
    const html = renderToday(SECTIONS);
    expect(html).toContain('data-testid="page-header"');
    expect(html).toContain("Friday, July 10");

    // Section order is DOM order.
    const reauthAt = html.indexOf('data-testid="today-section-reauth"');
    const reviewsAt = html.indexOf(
      'data-testid="today-section-negative-reviews"',
    );
    expect(reauthAt).toBeGreaterThan(-1);
    expect(reviewsAt).toBeGreaterThan(reauthAt);

    // Each card is a link with its single action.
    expect(html).toContain('href="/settings/integrations"');
    expect(html).toContain("Reconnect");
    expect(html).toContain('href="/reviews/rev-1"');
    expect(html).toContain("Respond");
    // The capped section shows its accurate overflow link.
    expect(html).toContain("3 more");

    // A populated queue shows no empty state.
    expect(html).not.toContain('data-testid="empty-state"');
  });

  it("all clear: the warm empty message and nothing else", () => {
    const html = renderToday([]);
    expect(html).toContain('data-testid="empty-state"');
    expect(html).toContain("Nothing needs your attention");
    // Zero cards, zero sections, and no filler widgets of any kind.
    expect(html).not.toContain('data-testid="today-card"');
    expect(html).not.toContain('data-testid="today-section');
    expect(html).not.toContain("<table");
    expect(html).not.toContain("<canvas");
    // The empty state's own icon is the page's only svg — no charts.
    expect((html.match(/<svg/g) ?? []).length).toBe(1);
  });
});
