// URL search-param contract for /reviews (#76): five filters + sort +
// cursor, parsed leniently — an unknown value reads as "no filter", never
// an error page. Pure and node-testable; the loader is a thin shell around
// it. Same shape as signals-search.ts (#88), the pattern's origin.
import {
  REVIEW_RESPONSE_STATUSES,
  type ReviewResponseStatus,
  type ReviewSourceKind,
  SENTIMENT_FILTERS,
  type SentimentFilter,
} from "@wellregarded/core";
import type { ReviewInboxFilters, ReviewInboxSort } from "@wellregarded/db";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `source` param's public vocabulary (#76: google | csv | manual) —
 * shorter than the internal `source_kind` enum on purpose; URLs are UI.
 */
export const REVIEW_SOURCE_PARAMS = ["google", "csv", "manual"] as const;

export type ReviewSourceParam = (typeof REVIEW_SOURCE_PARAMS)[number];

const SOURCE_PARAM_TO_KIND: Record<ReviewSourceParam, ReviewSourceKind> = {
  google: "google",
  csv: "csv_import",
  manual: "manual",
};

function oneOf<T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | undefined {
  return value !== null && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

export interface ReviewsSearch {
  filters: ReviewInboxFilters;
  sort: ReviewInboxSort;
  cursor: string | null;
  /** The raw param values the controls re-render with. */
  values: {
    source: ReviewSourceParam | "";
    status: ReviewResponseStatus | "";
    locationId: string;
    ratings: number[];
    sentiment: SentimentFilter | "";
  };
  /** True when any filter narrows the list — zero results then mean
   * "nothing matches", not "no reviews yet". */
  filtered: boolean;
}

export function parseReviewsSearch(
  searchParams: URLSearchParams,
): ReviewsSearch {
  const filters: ReviewInboxFilters = {};

  const source = oneOf<ReviewSourceParam>(
    searchParams.get("source"),
    REVIEW_SOURCE_PARAMS,
  );
  if (source) filters.source = SOURCE_PARAM_TO_KIND[source];

  const status = oneOf<ReviewResponseStatus>(
    searchParams.get("status"),
    REVIEW_RESPONSE_STATUSES,
  );
  if (status) filters.status = status;

  const locationId = searchParams.get("location");
  if (locationId && UUID_RE.test(locationId)) filters.locationId = locationId;

  // Multi-select whole stars: ?rating=1&rating=2. Junk values drop out.
  const ratings = [
    ...new Set(
      searchParams
        .getAll("rating")
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 1 && value <= 5),
    ),
  ].sort();
  if (ratings.length > 0) filters.ratings = ratings;

  const sentiment = oneOf<SentimentFilter>(
    searchParams.get("sentiment"),
    SENTIMENT_FILTERS,
  );
  if (sentiment) filters.sentiment = sentiment;

  const sort: ReviewInboxSort =
    searchParams.get("sort") === "newest" ? "newest" : "attention";

  return {
    filters,
    sort,
    cursor: searchParams.get("cursor"),
    values: {
      source: source ?? "",
      status: status ?? "",
      locationId: filters.locationId ?? "",
      ratings,
      sentiment: sentiment ?? "",
    },
    filtered: Object.keys(filters).length > 0,
  };
}

/** Href with one param changed and the cursor dropped — tab and source-chip
 * links keep every other filter but always restart pagination. */
export function withParam(
  searchParams: URLSearchParams,
  name: string,
  value: string | null,
): string {
  const next = new URLSearchParams(searchParams);
  next.delete("cursor");
  if (value === null) {
    next.delete(name);
  } else {
    next.set(name, value);
  }
  const text = next.toString();
  return text.length > 0 ? `/reviews?${text}` : "/reviews";
}
