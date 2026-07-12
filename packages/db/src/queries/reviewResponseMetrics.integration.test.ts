/**
 * reviewResponseMetrics (issue #86) against real Postgres: a seeded
 * fixture spanning three months and two locations, some responded — exact
 * rates, exact medians (odd and even counts), and the month-end
 * retrospective unresponded trend including the month a late response
 * lands. Month bucketing is asserted in the practice's timezone.
 */

import { describe, expect, it } from "vitest";

import { location, practice, response, signal } from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import { reviewResponseMetrics } from "./reviewResponseMetrics.js";

const t = setupTestDb();

/** Frozen "now": 2026-07-15 12:00Z (07:00 in America/Chicago). */
const NOW = new Date("2026-07-15T12:00:00Z");

const HOUR = 3600;
const DAY = 24 * HOUR;

interface Fixture {
  practiceId: string;
  locA: string;
  locB: string;
}

/** A public Google review at `occurredAt`, optionally with a published
 * response at `publishedAt`. */
async function review(
  fx: Fixture,
  locationId: string,
  occurredAt: string,
  publishedAt?: string,
): Promise<string> {
  const row = await signal(t.db, {
    practiceId: fx.practiceId,
    locationId,
    sourceKind: "google",
    sourceId: `review-${occurredAt}-${locationId}`,
    visibility: "public",
    occurredAt: new Date(occurredAt),
    originalText: "The visit went fine.",
  });
  if (publishedAt) {
    await response(t.db, {
      practiceId: fx.practiceId,
      signalId: row.id,
      status: "published",
      publishedAt: new Date(publishedAt),
    });
  }
  return row.id;
}

async function seedFixture(): Promise<Fixture> {
  const p = await practice(t.db, { timezone: "America/Chicago" });
  const a = await location(t.db, { practiceId: p.id, name: "Main Street" });
  const b = await location(t.db, { practiceId: p.id, name: "North Side" });
  const fx = { practiceId: p.id, locA: a.id, locB: b.id };

  // May 2026 — 3 reviews, 2 responded (even median: 48h & 12h → 30h).
  await review(fx, fx.locA, "2026-05-10T15:00:00Z", "2026-05-12T15:00:00Z"); // 48h
  await review(fx, fx.locA, "2026-05-20T15:00:00Z"); // unresponded forever
  await review(fx, fx.locB, "2026-05-25T15:00:00Z", "2026-05-26T03:00:00Z"); // 12h

  // June 2026 — 3 reviews; one answered only in July (the trend must show
  // it unresponded at June-end and gone from the backlog in July).
  await review(fx, fx.locB, "2026-06-05T15:00:00Z", "2026-06-05T19:00:00Z"); // 4h
  await review(fx, fx.locA, "2026-06-10T15:00:00Z", "2026-07-02T15:00:00Z"); // 22d
  await review(fx, fx.locB, "2026-06-20T15:00:00Z"); // unresponded

  // July 2026 — 1 review, responded (odd single-value median).
  await review(fx, fx.locB, "2026-07-03T15:00:00Z", "2026-07-04T03:00:00Z"); // 12h

  // Backlog with no lower bound: an ancient unanswered review counts as
  // unresponded in EVERY month of the window, but sits outside the
  // 12-month rate/median range.
  await review(fx, fx.locA, "2025-01-15T15:00:00Z");

  // Noise that must not count: a private manual signal, a public review
  // in another practice.
  await signal(t.db, {
    practiceId: fx.practiceId,
    visibility: "private",
    occurredAt: new Date("2026-06-15T15:00:00Z"),
  });
  const other = await practice(t.db);
  await signal(t.db, {
    practiceId: other.id,
    sourceKind: "google",
    sourceId: "other-practice-review",
    visibility: "public",
    occurredAt: new Date("2026-06-15T15:00:00Z"),
  });

  return fx;
}

describe("reviewResponseMetrics", () => {
  it("computes rate, medians (odd/even), locations, and the retrospective trend", async () => {
    const fx = await seedFixture();
    const metrics = await reviewResponseMetrics(t.db, {
      practiceId: fx.practiceId,
      now: NOW,
    });

    // Exactly 12 months, oldest first, ending on the current local month.
    expect(metrics.months).toHaveLength(12);
    expect(metrics.months[0]?.month).toBe("2025-08");
    expect(metrics.months[11]?.month).toBe("2026-07");

    const byMonth = new Map(metrics.months.map((m) => [m.month, m]));
    expect(byMonth.get("2026-05")).toMatchObject({
      total: 3,
      responded: 2,
      responseRate: 2 / 3,
      medianResponseSeconds: (48 * HOUR + 12 * HOUR) / 2, // even count
    });
    expect(byMonth.get("2026-06")).toMatchObject({
      total: 3,
      responded: 2, // the July-published response still counts as of now
      responseRate: 2 / 3,
      medianResponseSeconds: (4 * HOUR + 22 * DAY) / 2,
    });
    expect(byMonth.get("2026-07")).toMatchObject({
      total: 1,
      responded: 1,
      responseRate: 1,
      medianResponseSeconds: 12 * HOUR,
    });
    // A month with no reviews is present and honest, not missing.
    expect(byMonth.get("2025-09")).toMatchObject({
      total: 0,
      responded: 0,
      responseRate: null,
      medianResponseSeconds: null,
    });

    // Whole-range totals: 7 in-window reviews (the 2025-01 backlog review
    // is outside the rate window), 5 responded, odd-count median = 12h.
    expect(metrics.totals).toEqual({
      total: 7,
      responded: 5,
      responseRate: 5 / 7,
      medianResponseSeconds: 12 * HOUR,
      smallSample: false,
    });

    // By location, most-reviewed first; no author anywhere in the shape.
    expect(metrics.locations).toEqual([
      {
        locationId: fx.locB,
        locationName: "North Side",
        total: 4,
        responded: 3,
        responseRate: 3 / 4,
        medianResponseSeconds: 12 * HOUR, // odd count: 12h, 4h, 12h
      },
      {
        locationId: fx.locA,
        locationName: "Main Street",
        total: 3,
        responded: 2,
        responseRate: 2 / 3,
        medianResponseSeconds: (48 * HOUR + 22 * DAY) / 2,
      },
    ]);

    // Month-end retrospective backlog: the ancient review floors every
    // month at 1; June-end counts the review answered only in July; the
    // July entry (as of now) shows the backlog it left shrinking.
    const trend = metrics.months.map((m) => [m.month, m.unresponded]);
    expect(trend.slice(8)).toEqual([
      ["2026-04", 1],
      ["2026-05", 2], // ancient + the May unresponded
      ["2026-06", 4], // + June unresponded + the not-yet-answered June review
      ["2026-07", 3], // the June review's July response lands
    ]);
    expect(trend[0]).toEqual(["2025-08", 1]);
  });

  it("buckets months in the practice's timezone", async () => {
    const p = await practice(t.db, { timezone: "America/Chicago" });
    // 2026-06-01T02:00Z is 2026-05-31 21:00 in Chicago — a May review.
    await signal(t.db, {
      practiceId: p.id,
      sourceKind: "google",
      sourceId: "tz-boundary",
      visibility: "public",
      occurredAt: new Date("2026-06-01T02:00:00Z"),
    });
    const metrics = await reviewResponseMetrics(t.db, {
      practiceId: p.id,
      now: NOW,
    });
    const byMonth = new Map(metrics.months.map((m) => [m.month, m.total]));
    expect(byMonth.get("2026-05")).toBe(1);
    expect(byMonth.get("2026-06")).toBe(0);

    // The same instant for a UTC practice lands in June.
    const utc = await practice(t.db, { timezone: "UTC" });
    await signal(t.db, {
      practiceId: utc.id,
      sourceKind: "google",
      sourceId: "tz-boundary-utc",
      visibility: "public",
      occurredAt: new Date("2026-06-01T02:00:00Z"),
    });
    const utcMetrics = await reviewResponseMetrics(t.db, {
      practiceId: utc.id,
      now: NOW,
    });
    const utcByMonth = new Map(
      utcMetrics.months.map((m) => [m.month, m.total]),
    );
    expect(utcByMonth.get("2026-05")).toBe(0);
    expect(utcByMonth.get("2026-06")).toBe(1);
  });

  it("flags a small sample instead of hiding values", async () => {
    const p = await practice(t.db);
    await signal(t.db, {
      practiceId: p.id,
      sourceKind: "google",
      sourceId: "only-one",
      visibility: "public",
      occurredAt: new Date("2026-07-01T15:00:00Z"),
    });
    const metrics = await reviewResponseMetrics(t.db, {
      practiceId: p.id,
      now: NOW,
    });
    expect(metrics.totals.total).toBe(1);
    expect(metrics.totals.smallSample).toBe(true);
    expect(metrics.totals.responseRate).toBe(0);
  });

  it("returns an honest empty shape for a practice with no reviews", async () => {
    const p = await practice(t.db);
    const metrics = await reviewResponseMetrics(t.db, {
      practiceId: p.id,
      now: NOW,
    });
    expect(metrics.months).toHaveLength(12);
    expect(metrics.totals).toEqual({
      total: 0,
      responded: 0,
      responseRate: null,
      medianResponseSeconds: null,
      smallSample: true,
    });
    expect(metrics.locations).toEqual([]);
    expect(metrics.months.every((m) => m.unresponded === 0)).toBe(true);
  });
});
