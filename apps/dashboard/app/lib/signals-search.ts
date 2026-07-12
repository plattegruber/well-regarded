// URL search-param contract for /signals (#88): the eight filters + FTS
// query + cursor, parsed leniently — an unknown value reads as "no filter",
// never an error page. Pure and node-testable; the loader is a thin shell
// around it.
import {
  SENTIMENT_FILTERS,
  type SentimentFilter,
  SIGNAL_VISIBILITIES,
  type SignalVisibility,
  SOURCE_KINDS,
  type SourceKind,
  URGENCY_FILTERS,
  type UrgencyFilter,
} from "@wellregarded/core";
import type { SignalListFilters } from "@wellregarded/db";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oneOf<T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | undefined {
  return value !== null && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

export interface SignalsSearch {
  filters: SignalListFilters;
  cursor: string | null;
  /** True when any filter (or search) narrows the list — zero results then
   * mean "nothing matches", not "no signals yet". */
  filtered: boolean;
}

export function parseSignalsSearch(
  searchParams: URLSearchParams,
): SignalsSearch {
  const q = searchParams.get("q")?.trim();
  const locationId = searchParams.get("location");
  const providerId = searchParams.get("provider");
  const filters: SignalListFilters = {};

  const sourceKind = oneOf<SourceKind>(
    searchParams.get("source_kind"),
    SOURCE_KINDS,
  );
  if (sourceKind) filters.sourceKind = sourceKind;
  const visibility = oneOf<SignalVisibility>(
    searchParams.get("visibility"),
    SIGNAL_VISIBILITIES,
  );
  if (visibility) filters.visibility = visibility;
  const sentiment = oneOf<SentimentFilter>(
    searchParams.get("sentiment"),
    SENTIMENT_FILTERS,
  );
  if (sentiment) filters.sentiment = sentiment;
  const urgency = oneOf<UrgencyFilter>(
    searchParams.get("urgency"),
    URGENCY_FILTERS,
  );
  if (urgency) filters.urgency = urgency;
  if (locationId && UUID_RE.test(locationId)) filters.locationId = locationId;
  if (providerId && UUID_RE.test(providerId)) filters.providerId = providerId;
  if (searchParams.get("suspected_duplicate") === "1") {
    filters.suspectedDuplicate = true;
  }
  if (q) filters.q = q;

  return {
    filters,
    cursor: searchParams.get("cursor"),
    filtered: Object.keys(filters).length > 0,
  };
}

/** The same params minus the cursor — "back to the latest" / filter form
 * round-trips keep every filter and drop pagination. */
export function withoutCursor(searchParams: URLSearchParams): string {
  const next = new URLSearchParams(searchParams);
  next.delete("cursor");
  const text = next.toString();
  return text.length > 0 ? `?${text}` : "";
}

/** Href for the next page: current filters + the new cursor. */
export function withCursor(
  searchParams: URLSearchParams,
  cursor: string,
): string {
  const next = new URLSearchParams(searchParams);
  next.set("cursor", cursor);
  return `?${next.toString()}`;
}
