// @vitest-environment happy-dom
// Stats strip (#86): the three cards + one trend line render display
// strings, sparse data shows the small-sample hint instead of hiding, and
// — THE RULE — nothing person-shaped exists anywhere in the strip
// (response health is a quality signal, not a leaderboard).
import { cleanup, render, screen } from "@testing-library/react";
import type { ReviewResponseMetrics } from "@wellregarded/db";
import { afterEach, describe, expect, it } from "vitest";

import { formatDuration, toStats } from "../../routes/reviews";
import { type ReviewStatsData, ReviewStatsStrip } from "./stats-strip";

afterEach(cleanup);

function stats(overrides: Partial<ReviewStatsData> = {}): ReviewStatsData {
  return {
    responseRate: "71%",
    medianResponse: "1.5d",
    unresponded: "4",
    unrespondedDelta: "↓ 2 vs last month",
    unrespondedTone: "positive",
    trend: [
      { month: "2026-05", rate: 0.5 },
      { month: "2026-06", rate: null },
      { month: "2026-07", rate: 1 },
    ],
    smallSample: false,
    ...overrides,
  };
}

describe("ReviewStatsStrip", () => {
  it("renders the three stat cards and the delta", () => {
    render(<ReviewStatsStrip stats={stats()} />);
    expect(screen.getByText("Response rate")).toBeTruthy();
    expect(screen.getByText("71%")).toBeTruthy();
    expect(screen.getByText("Median time to respond")).toBeTruthy();
    expect(screen.getByText("1.5d")).toBeTruthy();
    expect(screen.getByText("Unresponded")).toBeTruthy();
    expect(screen.getByText("↓ 2 vs last month")).toBeTruthy();
  });

  it("renders exactly one trend line (an SVG polyline, no chart library)", () => {
    const { container } = render(<ReviewStatsStrip stats={stats()} />);
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    expect(container.querySelectorAll("polyline")).toHaveLength(1);
    // Null months leave gaps: only 2 plotted points for 3 months.
    expect(container.querySelectorAll("circle")).toHaveLength(2);
  });

  it("shows the small-sample hint instead of hiding values", () => {
    render(
      <ReviewStatsStrip
        stats={stats({ smallSample: true, unresponded: "1" })}
      />,
    );
    expect(screen.getByText(/small sample/i)).toBeTruthy();
    expect(screen.getByText("71%")).toBeTruthy();
  });
});

describe("toStats", () => {
  const months: ReviewResponseMetrics["months"] = [
    {
      month: "2026-06",
      total: 3,
      responded: 2,
      responseRate: 2 / 3,
      medianResponseSeconds: 3600,
      unresponded: 6,
    },
    {
      month: "2026-07",
      total: 1,
      responded: 1,
      responseRate: 1,
      medianResponseSeconds: 43200,
      unresponded: 4,
    },
  ];

  it("formats rate/median/backlog and the down-is-good delta", () => {
    const view = toStats({
      months,
      locations: [],
      totals: {
        total: 4,
        responded: 3,
        responseRate: 0.75,
        medianResponseSeconds: 130_000,
        smallSample: true,
      },
    });
    expect(view.responseRate).toBe("75%");
    expect(view.medianResponse).toBe("1.5d");
    expect(view.unresponded).toBe("4");
    expect(view.unrespondedDelta).toBe("↓ 2 vs last month");
    expect(view.unrespondedTone).toBe("positive");
    expect(view.smallSample).toBe(true);
    // Nothing person-shaped in the view model — the strip has nowhere to
    // put an author name or a per-staff count (#86 requirement 3).
    expect(JSON.stringify(view)).not.toMatch(/author|staff|member/i);
  });

  it("renders honest dashes when nothing is in range", () => {
    const view = toStats({
      months: [
        {
          month: "2026-07",
          total: 0,
          responded: 0,
          responseRate: null,
          medianResponseSeconds: null,
          unresponded: 0,
        },
      ],
      locations: [],
      totals: {
        total: 0,
        responded: 0,
        responseRate: null,
        medianResponseSeconds: null,
        smallSample: true,
      },
    });
    expect(view.responseRate).toBe("—");
    expect(view.medianResponse).toBe("—");
    expect(view.unrespondedDelta).toBeNull();
  });
});

describe("formatDuration", () => {
  it("chooses humane units", () => {
    expect(formatDuration(120)).toBe("2m");
    expect(formatDuration(14_400)).toBe("4h");
    expect(formatDuration(172_800)).toBe("2.0d");
  });
});
