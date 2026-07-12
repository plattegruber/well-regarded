// Reviews (#76): the response workspace — every public review, filterable,
// ordered by what needs attention rather than recency (unresponded
// negatives first, oldest first; the tiers are documented on
// `listReviewInbox` in packages/db). Reviews ARE signals: the loader reads
// `signals` through the review predicate; response status derives from the
// latest response row (none exist until #80 — every review honestly reads
// "needs response").
import {
  REVIEW_RESPONSE_STATUSES,
  type ReviewResponseStatus,
  SENTIMENTS,
  type SentimentFilter,
} from "@wellregarded/core";
import {
  countReviewInboxStatuses,
  listPracticeLocations,
  listReviewInbox,
  type ReviewInboxItem,
  type ReviewResponseMetrics,
  reviewResponseMetrics,
} from "@wellregarded/db";
import { Form, Link, useSearchParams } from "react-router";

import {
  REVIEW_SOURCE_FILTER_LABELS,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_TONES,
} from "~/components/reviews/labels";
import {
  type ReviewStatsData,
  ReviewStatsStrip,
} from "~/components/reviews/stats-strip";
import { Overline, PageHeader } from "~/components/shell/page-header";
import { JudgmentChip } from "~/components/signals/basis-badge";
import {
  formatAge,
  judgmentValueLabel,
  SOURCE_KIND_LABELS,
} from "~/components/signals/labels";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { RatingStars } from "~/components/ui/rating-stars";
import { Select } from "~/components/ui/select";
import { withRequestDb } from "~/lib/db.server";
import { requirePracticeContext } from "~/lib/practice-context.server";
import {
  parseReviewsSearch,
  REVIEW_SOURCE_PARAMS,
  withParam,
} from "~/lib/reviews-search";
import { withCursor } from "~/lib/signals-search";
import { SURFACES, surfaceIcon, surfaceTitle } from "~/lib/surfaces";
import type { Route } from "./+types/reviews";

const surface = SURFACES.reviews;

export function meta() {
  return [{ title: surfaceTitle(surface) }];
}

/** ~140 chars (#76 requirement 5) — the row is a scent, not the review. */
const EXCERPT_LENGTH = 140;

const SENTIMENT_TONES: Record<string, "positive" | "caution" | "negative"> = {
  positive: "positive",
  mixed: "caution",
  negative: "negative",
};

/** Row view-model: display-ready strings only; dates format server-side. */
export interface ReviewRow {
  id: string;
  sourceLabel: string;
  age: string;
  excerpt: string;
  rating: number | null;
  locationName: string | null;
  providerName: string | null;
  status: ReviewResponseStatus;
  sentiment: {
    label: string;
    tone: "positive" | "caution" | "negative";
  } | null;
  /** Current response-risk derivation is `high` — the red-outline marker. */
  highResponseRisk: boolean;
  deletedAtSource: boolean;
  // TODO(Epic #15): assignee avatar from the linked `recovery_items`
  // owner (#76 requirement 5) — the table does not exist yet.
}

/** "1.5d" / "14h" / "45m" — the median card's humane duration. */
export function formatDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 24 * 3600) return `${Math.round(seconds / 3600)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

/**
 * Metrics → display strings (#86). Server-side on purpose: the strip
 * renders text, never raw floats. NO author names anywhere in this shape
 * — response health is a quality signal, not a leaderboard (the rule is
 * documented on the db helper).
 */
export function toStats(metrics: ReviewResponseMetrics): ReviewStatsData {
  const { totals, months } = metrics;
  const current = months[months.length - 1];
  const previous = months[months.length - 2];
  const unresponded = current?.unresponded ?? 0;
  const delta =
    previous === undefined ? null : unresponded - previous.unresponded;
  return {
    responseRate:
      totals.responseRate === null
        ? "—"
        : `${Math.round(totals.responseRate * 100)}%`,
    medianResponse:
      totals.medianResponseSeconds === null
        ? "—"
        : formatDuration(totals.medianResponseSeconds),
    unresponded: String(unresponded),
    unrespondedDelta:
      delta === null || delta === 0
        ? delta === 0
          ? "± 0 vs last month"
          : null
        : `${delta < 0 ? "↓" : "↑"} ${Math.abs(delta)} vs last month`,
    // A shrinking backlog is the good direction.
    unrespondedTone:
      delta === null || delta === 0
        ? "neutral"
        : delta < 0
          ? "positive"
          : "negative",
    trend: months.map((m) => ({ month: m.month, rate: m.responseRate })),
    smallSample: totals.smallSample,
  };
}

function toRow(item: ReviewInboxItem, now: Date): ReviewRow {
  const text = item.text ?? "No text recorded.";
  return {
    id: item.id,
    sourceLabel: SOURCE_KIND_LABELS[item.sourceKind],
    age: formatAge(item.occurredAt, now),
    excerpt:
      text.length > EXCERPT_LENGTH
        ? `${text.slice(0, EXCERPT_LENGTH).trimEnd()}…`
        : text,
    rating: item.rating === null ? null : Number(item.rating),
    locationName: item.locationName,
    providerName: item.providerName,
    status: item.status,
    sentiment: item.sentiment
      ? {
          label: judgmentValueLabel(item.sentiment.value),
          tone:
            SENTIMENT_TONES[item.sentiment.value as SentimentFilter] ??
            "caution",
        }
      : null,
    highResponseRisk: item.responseRisk?.value === "high",
    deletedAtSource: item.availability === "deleted_at_source",
  };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const search = parseReviewsSearch(url.searchParams);

  return withRequestDb(context, async (db) => {
    // TODO(#59): requirePracticeContext is the auth seam — see its module doc.
    const { practiceId } = await requirePracticeContext(db);
    // Metrics run in the same Promise.all as the inbox (#86) — three
    // extra aggregate queries, fine at M1 volume. If they ever push the
    // page past its ~200ms budget, defer them (React Router `defer`):
    // inbox first, stats stream in.
    const [page, counts, locations, metrics] = await Promise.all([
      listReviewInbox(db, {
        practiceId,
        filters: search.filters,
        sort: search.sort,
        cursor: search.cursor,
      }),
      countReviewInboxStatuses(db, {
        practiceId,
        filters: search.filters,
      }),
      listPracticeLocations(db, practiceId),
      reviewResponseMetrics(db, { practiceId }),
    ]);

    const now = new Date();
    return {
      surface,
      rows: page.items.map((item) => toRow(item, now)),
      nextCursor: page.nextCursor,
      counts,
      filtered: search.filtered,
      paginated: search.cursor !== null,
      sort: search.sort,
      values: search.values,
      locations: locations.map((row) => ({ id: row.id, name: row.name })),
      stats: toStats(metrics),
    };
  });
}

type LoaderData = Route.ComponentProps["loaderData"];

/**
 * Counted tabs per the mockup — links, not buttons, so the URL stays the
 * single source of truth and the row works without JS. Styling follows
 * components/ui/tabs.tsx (the DS underline treatment).
 */
function StatusTabs({
  counts,
  active,
  searchParams,
}: {
  counts: LoaderData["counts"];
  active: ReviewResponseStatus | "";
  searchParams: URLSearchParams;
}) {
  const tabs: Array<{
    value: ReviewResponseStatus | "";
    label: string;
    count: number;
  }> = [
    { value: "", label: "All", count: counts.total },
    ...REVIEW_RESPONSE_STATUSES.map((status) => ({
      value: status,
      label: REVIEW_STATUS_LABELS[status],
      count: counts[status],
    })),
  ];
  return (
    <nav
      aria-label="Response status"
      data-testid="review-tabs"
      className="flex flex-wrap gap-1 border-b border-hairline"
    >
      {tabs.map((tab) => {
        const isActive = active === tab.value;
        return (
          <Link
            key={tab.value || "all"}
            to={withParam(searchParams, "status", tab.value || null)}
            aria-current={isActive ? "page" : undefined}
            className={`-mb-px inline-flex items-center gap-1.75 border-b-2 px-3.5 py-2.5 font-sans text-sm no-underline transition-colors duration-100 ease-out ${
              isActive
                ? "border-accent-600 font-semibold text-ink-900"
                : "border-transparent font-normal text-gray-600 hover:text-ink-900"
            }`}
          >
            {tab.label}
            <span
              className={`px-1.5 py-0.75 font-mono text-2xs font-medium tabular-nums ${
                isActive
                  ? "bg-accent-100 text-accent-700"
                  : "bg-gray-100 text-gray-600"
              }`}
            >
              {tab.count}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

/** Source filter chips per the mockup — Tag-styled links. */
function SourceChips({
  active,
  searchParams,
}: {
  active: string;
  searchParams: URLSearchParams;
}) {
  const chips = [
    { value: "", label: "All sources" },
    ...REVIEW_SOURCE_PARAMS.map((value) => ({
      value,
      label: REVIEW_SOURCE_FILTER_LABELS[value],
    })),
  ];
  return (
    <div className="flex flex-wrap gap-2" data-testid="source-chips">
      {chips.map((chip) => {
        const selected = active === chip.value;
        return (
          <Link
            key={chip.value || "all"}
            to={withParam(searchParams, "source", chip.value || null)}
            aria-current={selected ? "true" : undefined}
            className={`inline-flex items-center whitespace-nowrap border px-2.5 py-1.75 font-mono text-xs font-medium leading-none no-underline transition-colors duration-100 ease-out ${
              selected
                ? "border-ink-900 bg-ink-900 text-on-dark"
                : "border-outline-strong bg-surface-card text-ink-900 hover:bg-gray-50"
            }`}
          >
            {chip.label}
          </Link>
        );
      })}
    </div>
  );
}

function FilterBar({
  values,
  sort,
  locations,
  filtered,
}: {
  values: LoaderData["values"];
  sort: LoaderData["sort"];
  locations: LoaderData["locations"];
  filtered: boolean;
}) {
  // A GET form: filters ARE the URL. Selects auto-submit; the button is
  // the no-JS path. Status and source travel as hidden inputs so the tab
  // and chip selections survive a form submit.
  const submitOnChange = (
    event: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>,
  ) => event.currentTarget.form?.requestSubmit();
  return (
    <Form
      method="get"
      className="flex flex-wrap items-end gap-2.5"
      data-testid="reviews-filters"
    >
      {values.status && (
        <input type="hidden" name="status" value={values.status} />
      )}
      {values.source && (
        <input type="hidden" name="source" value={values.source} />
      )}
      <Select
        name="location"
        label="Location"
        defaultValue={values.locationId}
        onChange={submitOnChange}
        options={[
          { value: "", label: "All" },
          ...locations.map((row) => ({ value: row.id, label: row.name })),
        ]}
      />
      <Select
        name="sentiment"
        label="Sentiment"
        defaultValue={values.sentiment}
        onChange={submitOnChange}
        options={[
          { value: "", label: "All" },
          ...SENTIMENTS.map((value) => ({
            value,
            label: judgmentValueLabel(value),
          })),
          { value: "unclassified", label: "Unclassified" },
        ]}
      />
      <fieldset className="m-0 flex items-center gap-3 border-0 p-0 pb-2.5">
        <legend className="float-left mr-1 p-0 font-mono text-label font-medium uppercase tracking-label text-gray-600">
          Rating
        </legend>
        {[1, 2, 3, 4, 5].map((star) => (
          <label
            key={star}
            className="flex items-center gap-1.5 font-mono text-label font-medium text-gray-600"
          >
            <input
              type="checkbox"
              name="rating"
              value={star}
              defaultChecked={values.ratings.includes(star)}
              onChange={submitOnChange}
            />
            {star}
          </label>
        ))}
      </fieldset>
      <Select
        name="sort"
        label="Sort"
        defaultValue={sort}
        onChange={submitOnChange}
        options={[
          { value: "attention", label: "Needs attention first" },
          { value: "newest", label: "Newest first" },
        ]}
      />
      <Button type="submit" variant="secondary" size="sm">
        Filter
      </Button>
      {filtered && (
        <Link
          to="/reviews"
          className="pb-2.5 font-mono text-label font-medium uppercase tracking-label text-link"
        >
          Clear
        </Link>
      )}
    </Form>
  );
}

function Row({ row }: { row: ReviewRow }) {
  return (
    <div
      data-testid="review-row"
      className="flex flex-col gap-2.5 border-t border-hairline py-5"
    >
      <div className="flex flex-wrap items-center gap-3">
        {row.rating !== null && <RatingStars rating={row.rating} size={14} />}
        <span className="font-mono text-label font-medium text-ink-800">
          {row.sourceLabel}
        </span>
        <span className="font-mono text-label text-gray-500">{row.age}</span>
        <span className="ml-auto flex items-center gap-2">
          {row.highResponseRisk && (
            <span
              data-testid="response-risk"
              className="inline-flex items-center border border-red-700 px-2 py-1.25 font-mono text-2xs font-medium uppercase tracking-label text-red-700"
            >
              Response risk
            </span>
          )}
          {row.sentiment && (
            <Badge tone={row.sentiment.tone}>{row.sentiment.label}</Badge>
          )}
          <Badge tone={REVIEW_STATUS_TONES[row.status]}>
            {REVIEW_STATUS_LABELS[row.status]}
          </Badge>
        </span>
      </div>
      <p className="m-0 font-mono text-quote text-ink-800">
        <Link
          to={`/reviews/${row.id}`}
          className="text-inherit no-underline hover:underline"
        >
          “{row.excerpt}”
        </Link>
      </p>
      {(row.providerName || row.locationName || row.deletedAtSource) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {row.providerName && <JudgmentChip label={row.providerName} />}
          {row.locationName && <JudgmentChip label={row.locationName} />}
          {row.deletedAtSource && <JudgmentChip label="Deleted at source" />}
        </div>
      )}
    </div>
  );
}

/** Onboarding-flavored empty state (#76 requirement 6) — real links, not
 * the generic coming-soon EmptyState. */
function NoReviewsYet() {
  const Icon = surfaceIcon(surface);
  return (
    <div
      data-testid="empty-state"
      className="flex flex-col items-center border border-hairline bg-surface-card px-8 py-24 text-center"
    >
      <Icon
        size={20}
        strokeWidth={1.75}
        className="text-gray-400"
        aria-hidden
      />
      <h2 className="mt-4.5 mb-0 text-title font-semibold text-ink-900">
        {surface.empty?.heading ?? "No public reviews yet"}
      </h2>
      <p className="mx-auto mt-2.5 mb-0 max-w-130 text-small text-gray-600">
        {surface.empty?.body ?? ""}
      </p>
      <div className="mt-6 flex items-center gap-4 font-mono text-label font-medium uppercase tracking-label">
        <Link to="/settings/integrations" className="text-link">
          Connect Google
        </Link>
        <Link to="/settings/imports" className="text-link">
          Import a CSV
        </Link>
      </div>
    </div>
  );
}

/** Zero-result state — distinct from the no-reviews-yet empty state. */
function NoMatches() {
  return (
    <div
      data-testid="zero-results"
      className="flex flex-col items-center border border-hairline bg-surface-card px-8 py-16 text-center"
    >
      <h2 className="m-0 text-title font-semibold text-ink-900">
        No reviews match
      </h2>
      <p className="mx-auto mt-2.5 mb-0 max-w-130 text-small text-gray-600">
        Nothing matches these filters. Loosen them, or clear everything to see
        the whole inbox again.
      </p>
      <Link
        to="/reviews"
        className="mt-5 font-mono text-label font-medium uppercase tracking-label text-link"
      >
        Clear filters
      </Link>
    </div>
  );
}

export default function Reviews({ loaderData }: Route.ComponentProps) {
  const {
    rows,
    nextCursor,
    counts,
    filtered,
    paginated,
    sort,
    values,
    locations,
    stats,
  } = loaderData;
  const [searchParams] = useSearchParams();
  // "No reviews ever" is a property of the corpus, not the current page:
  // counts ignore the status tab, so total = 0 with no other filters set
  // means the practice truly has nothing here yet.
  const empty =
    counts.total === 0 && rows.length === 0 && !filtered && !paginated;

  return (
    <>
      <PageHeader
        overline={surface.overline}
        title={surface.title}
        description={surface.description}
      />
      {empty ? (
        <NoReviewsYet />
      ) : (
        <>
          {/* Response-health strip (#86) — header area per the mock's
              stat-strip style. TODO(epic-17): moves to /insights once
              that surface exists (it is an empty state today). */}
          <ReviewStatsStrip stats={stats} />
          <StatusTabs
            counts={counts}
            active={values.status}
            searchParams={searchParams}
          />
          <div className="mt-4.5 mb-1.5 flex flex-wrap items-end justify-between gap-3">
            <SourceChips active={values.source} searchParams={searchParams} />
          </div>
          <div className="mb-5">
            <FilterBar
              values={values}
              sort={sort}
              locations={locations}
              filtered={filtered}
            />
          </div>
          {rows.length === 0 ? (
            <NoMatches />
          ) : (
            <div className="flex flex-col">
              <Overline className="pb-2.5">
                {sort === "attention"
                  ? "Ordered by what needs attention"
                  : "Newest first"}
              </Overline>
              {rows.map((row) => (
                <Row key={row.id} row={row} />
              ))}
            </div>
          )}
          {(nextCursor || paginated) && (
            <div className="mt-5 flex items-center gap-4 border-t border-hairline pt-4 font-mono text-label font-medium uppercase tracking-label">
              {paginated && (
                <Link
                  to={withParam(searchParams, "cursor", null)}
                  className="text-link"
                >
                  Back to the top
                </Link>
              )}
              {nextCursor && (
                <Link
                  to={withCursor(searchParams, nextCursor)}
                  className="text-link"
                >
                  More reviews
                </Link>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}
