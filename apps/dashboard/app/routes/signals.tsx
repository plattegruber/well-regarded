// Signals (#88): the unified inbox — every trust signal regardless of
// source, one filterable, full-text-searchable list. The system-of-record
// surface: visibility is impossible to misread, patient identity is
// redacted at the data layer (packages/db), and rights are stated strictly
// in terms of recorded consent.
//
// Layout follows the mockup's Source / Signal / Rights table, including the
// dashed "· inferred" chips and the consent color-coding.
import {
  describeConsentState,
  SENTIMENTS,
  type SentimentFilter,
  SOURCE_KINDS,
  URGENCY_LEVELS,
} from "@wellregarded/core";
import {
  listSignalFilterOptions,
  listSignals,
  type SignalListItem,
} from "@wellregarded/db";
import { Form, Link, useSearchParams } from "react-router";

import { EmptyState } from "~/components/empty-state";
import { Overline, PageHeader } from "~/components/shell/page-header";
import { JudgmentChip } from "~/components/signals/basis-badge";
import { consentToneClass } from "~/components/signals/consent-panel";
import {
  formatAge,
  judgmentValueLabel,
  SOURCE_KIND_LABELS,
} from "~/components/signals/labels";
import { VisibilityBadge } from "~/components/signals/visibility-badge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { RatingStars } from "~/components/ui/rating-stars";
import { Select } from "~/components/ui/select";
import { withRequestDb } from "~/lib/db.server";
import { requirePracticeContext } from "~/lib/practice-context.server";
import {
  parseSignalsSearch,
  withCursor,
  withoutCursor,
} from "~/lib/signals-search";
import { SURFACES, surfaceIcon, surfaceTitle } from "~/lib/surfaces";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/signals";

const surface = SURFACES.signals;

export function meta() {
  return [{ title: surfaceTitle(surface) }];
}

const EXCERPT_LENGTH = 260;

const SENTIMENT_TONES: Record<string, "positive" | "caution" | "negative"> = {
  positive: "positive",
  mixed: "caution",
  negative: "negative",
};

/** Row view-model: display-ready strings only; dates format server-side. */
export interface SignalRow {
  id: string;
  sourceLabel: string;
  visibility: SignalListItem["visibility"];
  age: string;
  text: string | null;
  rating: number | null;
  patientLabel: string | null;
  locationName: string | null;
  providerName: string | null;
  sentiment: {
    label: string;
    tone: "positive" | "caution" | "negative";
  } | null;
  /** Only medium and above — low/none would be noise on every row. */
  urgency: {
    label: string;
    basis: NonNullable<SignalListItem["urgency"]>["basis"];
  } | null;
  suspectedDuplicate: boolean;
  edited: boolean;
  deletedAtSource: boolean;
  consent: {
    summary: string;
    status: ReturnType<typeof describeConsentState>["status"];
  };
}

function toRow(item: SignalListItem, now: Date): SignalRow {
  const consent = describeConsentState(item.consent ? [item.consent] : [], now);
  const text = item.text
    ? item.text.length > EXCERPT_LENGTH
      ? `${item.text.slice(0, EXCERPT_LENGTH).trimEnd()}…`
      : item.text
    : null;
  const urgencyValue = item.urgency?.value;
  const urgent =
    item.urgency &&
    (urgencyValue === "medium" ||
      urgencyValue === "high" ||
      urgencyValue === "critical");
  return {
    id: item.id,
    sourceLabel: SOURCE_KIND_LABELS[item.sourceKind],
    visibility: item.visibility,
    age: formatAge(item.occurredAt, now),
    text,
    rating: item.rating === null ? null : Number(item.rating),
    patientLabel:
      item.patient === null
        ? null
        : item.patient.redacted
          ? "Patient (hidden)"
          : (item.patient.displayName ?? "Patient (unnamed)"),
    locationName: item.locationName,
    providerName: item.providerName,
    sentiment: item.sentiment
      ? {
          label: judgmentValueLabel(item.sentiment.value),
          tone:
            SENTIMENT_TONES[item.sentiment.value as SentimentFilter] ??
            "caution",
        }
      : null,
    urgency:
      item.urgency && urgent
        ? {
            label: `${judgmentValueLabel(item.urgency.value)} urgency`,
            basis: item.urgency.basis,
          }
        : null,
    suspectedDuplicate: item.suspectedDuplicate,
    edited: item.edited,
    deletedAtSource: item.availability === "deleted_at_source",
    consent: { summary: consent.summary, status: consent.status },
  };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const search = parseSignalsSearch(url.searchParams);

  return withRequestDb(context, async (db) => {
    // TODO(#59): requirePracticeContext is the auth seam — see its module doc.
    const { practiceId, viewer } = await requirePracticeContext(db);
    const [page, options] = await Promise.all([
      listSignals(db, {
        practiceId,
        viewer,
        filters: search.filters,
        cursor: search.cursor,
      }),
      listSignalFilterOptions(db, practiceId),
    ]);

    const now = new Date();
    return {
      surface,
      rows: page.items.map((item) => toRow(item, now)),
      nextCursor: page.nextCursor,
      filtered: search.filtered,
      paginated: search.cursor !== null,
      filterValues: {
        sourceKind: search.filters.sourceKind ?? "",
        visibility: search.filters.visibility ?? "",
        sentiment: search.filters.sentiment ?? "",
        urgency: search.filters.urgency ?? "",
        locationId: search.filters.locationId ?? "",
        providerId: search.filters.providerId ?? "",
        suspectedDuplicate: search.filters.suspectedDuplicate ?? false,
        q: search.filters.q ?? "",
      },
      options,
    };
  });
}

const ANY = { value: "", label: "All" };

function label(text: string): string {
  return judgmentValueLabel(text);
}

function FilterBar({
  filterValues,
  options,
  filtered,
}: {
  filterValues: Route.ComponentProps["loaderData"]["filterValues"];
  options: Route.ComponentProps["loaderData"]["options"];
  filtered: boolean;
}) {
  // A GET form: filters ARE the URL. Selects auto-submit; the button is
  // the no-JS path.
  const submitOnChange = (
    event: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>,
  ) => event.currentTarget.form?.requestSubmit();
  return (
    <Form
      method="get"
      className="mb-6 flex flex-col gap-3.5"
      data-testid="signals-filters"
    >
      <div className="flex max-w-130 flex-col gap-1.5">
        <Input
          name="q"
          type="search"
          label="Search"
          defaultValue={filterValues.q}
          placeholder="Search all signals"
          hint="Use quotes for exact phrases, -word to exclude."
        />
      </div>
      <div className="flex flex-wrap items-end gap-2.5">
        <Select
          name="source_kind"
          label="Source"
          defaultValue={filterValues.sourceKind}
          onChange={submitOnChange}
          options={[
            ANY,
            ...SOURCE_KINDS.map((kind) => ({
              value: kind,
              label: SOURCE_KIND_LABELS[kind],
            })),
          ]}
        />
        <Select
          name="visibility"
          label="Visibility"
          defaultValue={filterValues.visibility}
          onChange={submitOnChange}
          options={[
            ANY,
            { value: "public", label: "Public" },
            { value: "private", label: "Private" },
          ]}
        />
        <Select
          name="sentiment"
          label="Sentiment"
          defaultValue={filterValues.sentiment}
          onChange={submitOnChange}
          options={[
            ANY,
            ...SENTIMENTS.map((value) => ({ value, label: label(value) })),
            { value: "unclassified", label: "Unclassified" },
          ]}
        />
        <Select
          name="urgency"
          label="Urgency"
          defaultValue={filterValues.urgency}
          onChange={submitOnChange}
          options={[
            ANY,
            ...URGENCY_LEVELS.map((value) => ({ value, label: label(value) })),
            { value: "unclassified", label: "Unclassified" },
          ]}
        />
        <Select
          name="location"
          label="Location"
          defaultValue={filterValues.locationId}
          onChange={submitOnChange}
          options={[
            ANY,
            ...options.locations.map((row) => ({
              value: row.id,
              label: row.name,
            })),
          ]}
        />
        <Select
          name="provider"
          label="Provider"
          defaultValue={filterValues.providerId}
          onChange={submitOnChange}
          options={[
            ANY,
            ...options.providers.map((row) => ({
              value: row.id,
              label: row.name,
            })),
          ]}
        />
        <label className="flex items-center gap-2 pb-2.5 font-mono text-label font-medium uppercase tracking-label text-gray-600">
          <input
            type="checkbox"
            name="suspected_duplicate"
            value="1"
            defaultChecked={filterValues.suspectedDuplicate}
            onChange={submitOnChange}
          />
          Possible duplicates
        </label>
        <Button type="submit" variant="secondary" size="sm">
          Filter
        </Button>
        {filtered && (
          <Link
            to="/signals"
            className="pb-2.5 font-mono text-label font-medium uppercase tracking-label text-link"
          >
            Clear
          </Link>
        )}
      </div>
    </Form>
  );
}

function Row({ row }: { row: SignalRow }) {
  return (
    <div
      data-testid="signal-row"
      className="grid grid-cols-[110px_1fr] items-start gap-4 border-t border-hairline py-4 md:grid-cols-[110px_1fr_170px]"
    >
      <div className="flex flex-col items-start gap-1.5">
        <div className="font-mono text-label font-medium text-ink-800">
          {row.sourceLabel}
        </div>
        <VisibilityBadge visibility={row.visibility} />
      </div>
      <div className="min-w-0">
        <p className="m-0 mb-2 font-mono text-quote text-ink-800">
          <Link
            to={`/signals/${row.id}`}
            className="text-inherit no-underline hover:underline"
          >
            {row.text ?? "No text recorded."}
          </Link>
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {row.providerName && <JudgmentChip label={row.providerName} />}
          {row.locationName && <JudgmentChip label={row.locationName} />}
          {row.patientLabel && <JudgmentChip label={row.patientLabel} />}
          {row.urgency && (
            <JudgmentChip label={row.urgency.label} basis={row.urgency.basis} />
          )}
          {row.suspectedDuplicate && (
            <span className="inline-flex items-center whitespace-nowrap border border-dashed border-amber-700 px-2 py-1.25 font-mono text-label font-medium leading-none text-amber-700">
              Possible duplicate
            </span>
          )}
          {row.edited && <JudgmentChip label="Edited at source" />}
          {row.deletedAtSource && <JudgmentChip label="Deleted at source" />}
        </div>
        <div className="mt-2 flex items-center gap-2.5 font-mono text-label text-gray-500">
          {row.rating !== null && <RatingStars rating={row.rating} size={11} />}
          <span>{row.age}</span>
        </div>
      </div>
      <div className="col-start-2 flex flex-row items-center gap-2 md:col-start-3 md:flex-col md:items-start">
        {row.sentiment && (
          <Badge tone={row.sentiment.tone}>{row.sentiment.label}</Badge>
        )}
        <span
          className={cn(
            "font-mono text-label font-medium",
            consentToneClass(row.consent.status),
          )}
        >
          {row.consent.summary}
        </span>
      </div>
    </div>
  );
}

/** Zero-result state — distinct from the no-signals-yet empty state. */
function NoMatches() {
  return (
    <div
      data-testid="zero-results"
      className="flex flex-col items-center border border-hairline bg-surface-card px-8 py-16 text-center"
    >
      <h2 className="m-0 text-title font-semibold text-ink-900">
        Nothing matches
      </h2>
      <p className="mx-auto mt-2.5 mb-0 max-w-130 text-small text-gray-600">
        No signals match these filters. Loosen them, or clear the search to see
        everything again.
      </p>
      <Link
        to="/signals"
        className="mt-5 font-mono text-label font-medium uppercase tracking-label text-link"
      >
        Clear filters
      </Link>
    </div>
  );
}

export default function Signals({ loaderData }: Route.ComponentProps) {
  const { rows, nextCursor, filtered, paginated, filterValues, options } =
    loaderData;
  const [searchParams] = useSearchParams();
  const empty = rows.length === 0 && !filtered && !paginated;

  return (
    <>
      <PageHeader
        overline={surface.overline}
        title={surface.title}
        description={surface.description}
      />
      {/* Manual entry (#138): staff capture of a phoned-in or handwritten
          compliment — placement on this surface per the issue. */}
      <div className="mb-5">
        <Link
          to="/signals/new"
          data-testid="add-signal"
          className="inline-flex items-center border border-ink-900 bg-ink-900 px-4.5 py-3 font-mono text-xs font-semibold uppercase leading-none tracking-label text-on-dark no-underline hover:bg-ink-700"
        >
          Add signal
        </Link>
      </div>
      {empty ? (
        <EmptyState
          icon={surfaceIcon(surface)}
          heading={surface.empty?.heading ?? "No signals yet"}
          body={surface.empty?.body ?? ""}
          actionLabel={surface.empty?.action?.label}
        />
      ) : (
        <>
          <FilterBar
            filterValues={filterValues}
            options={options}
            filtered={filtered}
          />
          {rows.length === 0 ? (
            <NoMatches />
          ) : (
            <div className="flex flex-col">
              <div className="hidden grid-cols-[110px_1fr_170px] gap-4 pb-2.5 md:grid">
                <Overline>Source</Overline>
                <Overline>Signal</Overline>
                <Overline>Rights</Overline>
              </div>
              {rows.map((row) => (
                <Row key={row.id} row={row} />
              ))}
            </div>
          )}
          {(nextCursor || paginated) && (
            <div className="mt-5 flex items-center gap-4 border-t border-hairline pt-4 font-mono text-label font-medium uppercase tracking-label">
              {paginated && (
                <Link to={withoutCursor(searchParams)} className="text-link">
                  Back to latest
                </Link>
              )}
              {nextCursor && (
                <Link
                  to={withCursor(searchParams, nextCursor)}
                  className="text-link"
                >
                  Older signals
                </Link>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}
