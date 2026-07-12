/**
 * Review response metrics (issue #86, Epic #10): response rate, median
 * time-to-response, and the unresponded backlog — by location and by
 * month — computed in SQL over `signals` + `responses`. Pure read model:
 * no new tables, no denormalized counters.
 *
 * **NO PER-STAFF-MEMBER METRICS — deliberately.** The product doc's rule
 * (issue #86 requirement 3): response health is a quality signal for the
 * practice, not a leaderboard. There is no response count by author, no
 * ranking, and none should be added here without revisiting that product
 * decision. Author identity never appears in any result shape this module
 * returns.
 *
 * Definitions (shared by all three queries):
 * - A **review** is the #76 predicate: `visibility = 'public'` AND
 *   `source_kind` in `REVIEW_SOURCE_KINDS`.
 * - A review is **responded** when a `responses` row with
 *   `status = 'published'` and a non-null `published_at` exists;
 *   time-to-response = earliest `published_at` − `occurred_at`.
 * - **Months are bucketed in the practice's timezone**
 *   (`practices.timezone` — Epic #4 stores one), the same choice #75's
 *   budget month-boundary makes; change both together.
 * - The **unresponded trend** is retrospective (issue #86 requirement 1):
 *   a review counts as unresponded in month M if it existed by M-end
 *   without a published response by M-end — computed from timestamps, so
 *   the month a response lands, the backlog it left shrinks. The current
 *   month's entry is "as of now" (its month-end hasn't happened; nothing
 *   can have occurred or published after `now`). The backlog has NO lower
 *   time bound — a review older than the window still owes a response.
 *
 * Medians use `percentile_cont(0.5)`; per-month/overall rate + median run
 * as ONE pass via GROUPING SETS, the by-location split as a second, and
 * the month-end series (a `generate_series` left-joined against the
 * existence/response predicates) as a third.
 */

import { REVIEW_SOURCE_KINDS } from "@wellregarded/core";
import { sql } from "drizzle-orm";

import type { Tx } from "../audit.js";
import type { Db } from "../client.js";

/** Months covered: the current practice-local month and the 11 before. */
export const METRICS_MONTHS = 12;

/** Below this many reviews in range the UI shows a small-sample hint. */
export const METRICS_SMALL_SAMPLE = 5;

export interface MonthMetrics {
  /** Practice-local month key, `YYYY-MM`. */
  month: string;
  /** Reviews that occurred in this month. */
  total: number;
  /** Of those, how many have a published response (as of now). */
  responded: number;
  /** responded / total; null when the month has no reviews. */
  responseRate: number | null;
  /** Median seconds from `occurred_at` to first `published_at`; null when
   * nothing in this month is responded. */
  medianResponseSeconds: number | null;
  /** Month-end retrospective unresponded backlog (see module doc). */
  unresponded: number;
}

export interface LocationMetrics {
  /** Null = reviews with no location association. */
  locationId: string | null;
  locationName: string | null;
  total: number;
  responded: number;
  responseRate: number | null;
  medianResponseSeconds: number | null;
}

export interface ReviewResponseMetrics {
  /** Oldest → newest, always exactly {@link METRICS_MONTHS} entries. */
  months: MonthMetrics[];
  /** Locations with ≥ 1 review in range, most-reviewed first. */
  locations: LocationMetrics[];
  /** Whole-range aggregate — what the stat cards show. */
  totals: {
    total: number;
    responded: number;
    responseRate: number | null;
    medianResponseSeconds: number | null;
    /** total < METRICS_SMALL_SAMPLE → render the small-sample hint. */
    smallSample: boolean;
  };
}

function rows(result: unknown): Record<string, unknown>[] {
  // postgres-js returns the row array directly; other drizzle drivers
  // return a pg-style `{ rows }` object (same note as hybridSearch.ts).
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : (((result as { rows?: unknown[] }).rows ?? []) as Record<
        string,
        unknown
      >[]);
}

const int = (value: unknown): number => Number(value ?? 0);
const floatOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

function rate(total: number, responded: number): number | null {
  return total === 0 ? null : responded / total;
}

/**
 * Compute the metrics (issue #86). `now` exists for tests; production
 * callers omit it. One helper, three SQL statements, no per-staff
 * anything (see the module doc for why that is a feature).
 */
export async function reviewResponseMetrics(
  db: Db | Tx,
  params: { practiceId: string; now?: Date },
): Promise<ReviewResponseMetrics> {
  const now = (params.now ?? new Date()).toISOString();
  const { practiceId } = params;
  const sourceKinds = sql.join(
    REVIEW_SOURCE_KINDS.map((kind) => sql`${kind}`),
    sql`, `,
  );

  // Shared prologue: the practice's timezone + current local month, and
  // the review set with each review's earliest published response.
  // `occurred_at AT TIME ZONE tz` yields the practice-local wall-clock
  // timestamp; all bucketing happens in that local space.
  const prologue = sql`
    bounds AS (
      SELECT p.timezone AS tz,
             date_trunc('month', ${now}::timestamptz AT TIME ZONE p.timezone) AS cur_month
      FROM practices p
      WHERE p.id = ${practiceId}
    ),
    reviews AS (
      SELECT s.id,
             s.location_id,
             s.occurred_at,
             (s.occurred_at AT TIME ZONE b.tz) AS occurred_local,
             fr.first_published_at,
             (fr.first_published_at AT TIME ZONE b.tz) AS responded_local
      FROM signals s
      CROSS JOIN bounds b
      LEFT JOIN LATERAL (
        SELECT min(r.published_at) AS first_published_at
        FROM responses r
        WHERE r.signal_id = s.id
          AND r.status = 'published'
          AND r.published_at IS NOT NULL
      ) fr ON true
      WHERE s.practice_id = ${practiceId}
        AND s.visibility = 'public'
        AND s.source_kind IN (${sourceKinds})
        AND s.occurred_at <= ${now}::timestamptz
    )`;

  const [byMonthResult, byLocationResult, trendResult] = await Promise.all([
    // Per-month rate + median, plus the whole-range aggregate, in one
    // pass (GROUPING SETS: (month), ()).
    db.execute(sql`
      WITH ${prologue}
      SELECT to_char(date_trunc('month', r.occurred_local), 'YYYY-MM') AS month,
             count(*)::int AS total,
             count(r.first_published_at)::int AS responded,
             (percentile_cont(0.5) WITHIN GROUP (
                ORDER BY extract(epoch FROM (r.first_published_at - r.occurred_at))
              ) FILTER (WHERE r.first_published_at IS NOT NULL))::float8 AS median_seconds
      FROM reviews r
      CROSS JOIN bounds b
      WHERE r.occurred_local >= b.cur_month - interval '${sql.raw(String(METRICS_MONTHS - 1))} months'
      GROUP BY GROUPING SETS ((date_trunc('month', r.occurred_local)), ())
      ORDER BY month NULLS LAST
    `),
    // By location, over the same range.
    db.execute(sql`
      WITH ${prologue}
      SELECT r.location_id,
             l.name AS location_name,
             count(*)::int AS total,
             count(r.first_published_at)::int AS responded,
             (percentile_cont(0.5) WITHIN GROUP (
                ORDER BY extract(epoch FROM (r.first_published_at - r.occurred_at))
              ) FILTER (WHERE r.first_published_at IS NOT NULL))::float8 AS median_seconds
      FROM reviews r
      CROSS JOIN bounds b
      LEFT JOIN locations l ON l.id = r.location_id
      WHERE r.occurred_local >= b.cur_month - interval '${sql.raw(String(METRICS_MONTHS - 1))} months'
      GROUP BY r.location_id, l.name
      ORDER BY count(*) DESC, l.name NULLS LAST
    `),
    // Month-end retrospective unresponded backlog over a generated month
    // series (issue #86 implementation note). Note: reviews has no lower
    // bound here — old unanswered reviews are still backlog.
    db.execute(sql`
      WITH ${prologue},
      months AS (
        SELECT generate_series(
                 b.cur_month - interval '${sql.raw(String(METRICS_MONTHS - 1))} months',
                 b.cur_month,
                 interval '1 month'
               ) AS month_start
        FROM bounds b
      )
      SELECT to_char(m.month_start, 'YYYY-MM') AS month,
             count(r.id) FILTER (
               WHERE r.occurred_local < m.month_start + interval '1 month'
                 AND (r.responded_local IS NULL
                      OR r.responded_local >= m.month_start + interval '1 month')
             )::int AS unresponded
      FROM months m
      LEFT JOIN reviews r ON true
      GROUP BY m.month_start
      ORDER BY m.month_start
    `),
  ]);

  const byMonth = new Map<
    string,
    { total: number; responded: number; medianSeconds: number | null }
  >();
  let totals: ReviewResponseMetrics["totals"] = {
    total: 0,
    responded: 0,
    responseRate: null,
    medianResponseSeconds: null,
    smallSample: true,
  };
  for (const row of rows(byMonthResult)) {
    const entry = {
      total: int(row.total),
      responded: int(row.responded),
      medianSeconds: floatOrNull(row.median_seconds),
    };
    if (row.month === null) {
      // The GROUPING SETS grand-total row.
      totals = {
        total: entry.total,
        responded: entry.responded,
        responseRate: rate(entry.total, entry.responded),
        medianResponseSeconds: entry.medianSeconds,
        smallSample: entry.total < METRICS_SMALL_SAMPLE,
      };
    } else {
      byMonth.set(row.month as string, entry);
    }
  }

  // The trend query's generate_series is the authoritative month list —
  // months with no reviews still appear (total 0, honest gaps).
  const months: MonthMetrics[] = rows(trendResult).map((row) => {
    const key = row.month as string;
    const monthEntry = byMonth.get(key);
    const total = monthEntry?.total ?? 0;
    const responded = monthEntry?.responded ?? 0;
    return {
      month: key,
      total,
      responded,
      responseRate: rate(total, responded),
      medianResponseSeconds: monthEntry?.medianSeconds ?? null,
      unresponded: int(row.unresponded),
    };
  });

  const locations: LocationMetrics[] = rows(byLocationResult).map((row) => {
    const total = int(row.total);
    const responded = int(row.responded);
    return {
      locationId: (row.location_id as string | null) ?? null,
      locationName: (row.location_name as string | null) ?? null,
      total,
      responded,
      responseRate: rate(total, responded),
      medianResponseSeconds: floatOrNull(row.median_seconds),
    };
  });

  return { months, locations, totals };
}
