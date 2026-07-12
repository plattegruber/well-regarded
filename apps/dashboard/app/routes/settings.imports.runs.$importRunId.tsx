// Import report (#137): what an import actually did — counts, the error
// table with original row values, the failures-CSV download, suspected
// duplicates, and a status timeline. Polls every ~5s while the run is
// `running` (stops on terminal status); a run stuck `running` past the
// staleness threshold renders "taking longer than expected" instead of an
// eternal spinner.
//
// Raw offending values are NOT stored on the run row (error samples carry
// `row:<n>` refs only) — they are reconstructed from the run's batch
// artifacts in R2, which ship every row. Rows whose batch can't be read
// render "not recoverable", never a guess.
//
// TODO(#59): auth flows through requirePracticeContext (the demo-practice
// seam) until Epic #4 wires Clerk.
import { can, IMPORT_RUN_ERROR_SAMPLE_CAP } from "@wellregarded/core";
import {
  getImportRunDraftInfo,
  getImportRunSummary,
  listSuspectedDuplicatesForImportRun,
} from "@wellregarded/db";
import { parseRowRef, readCsvBatchRows } from "@wellregarded/sources";
import { useState } from "react";
import { data, Link, useSearchParams } from "react-router";

import {
  isImportRunStale,
  RunStatusBadge,
} from "~/components/imports/run-status";
import { useImportRunPolling } from "~/components/imports/use-run-polling";
import { Overline, PageHeader } from "~/components/shell/page-header";
import { formatDate, SOURCE_KIND_LABELS } from "~/components/signals/labels";
import { Card } from "~/components/ui/card";
import { withRequestDb } from "~/lib/db.server";
import { requirePracticeContext } from "~/lib/practice-context.server";
import type { Route } from "./+types/settings.imports.runs.$importRunId";

export function meta() {
  return [{ title: "Import report · Well Regarded" }];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ERROR_PAGE_SIZE = 20;

export type ErrorSort = "asc" | "desc";

/** One error-table row: display-ready, values reconstructed when possible. */
export interface ErrorRow {
  /** 1-based data-row number, null for pipeline-stage failures. */
  rowNumber: number | null;
  reason: string;
  /** Original cell values; null = not recoverable from provenance. */
  values: string[] | null;
  /** Where the failure surfaced (`import`, `ingest`, ...). */
  stage: string;
  /** Raw payload ref, shown for stage-level failures. */
  payloadRef: string;
}

export interface DuplicateRow {
  linkId: string;
  status: string;
  a: DuplicateSide;
  b: DuplicateSide;
}

export interface DuplicateSide {
  signalId: string;
  sourceLabel: string;
  visibilityLabel: string;
  occurredOn: string;
  snippet: string;
  fromThisRun: boolean;
}

const SNIPPET_LENGTH = 140;

function snippet(text: string | null): string {
  if (!text) return "No text recorded.";
  return text.length > SNIPPET_LENGTH
    ? `${text.slice(0, SNIPPET_LENGTH).trimEnd()}…`
    : text;
}

function timeLabel(date: Date): string {
  return `${formatDate(date)}, ${new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date)} UTC`;
}

function durationLabel(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / (60 * 60_000)).toFixed(1)}h`;
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  if (!UUID_RE.test(params.importRunId)) throw data(null, { status: 404 });
  const url = new URL(request.url);
  const sort: ErrorSort =
    url.searchParams.get("errors_sort") === "desc" ? "desc" : "asc";
  const requestedPage = Number(url.searchParams.get("errors_page") ?? "1");

  return withRequestDb(context, async (db) => {
    const ctx = await requirePracticeContext(db);
    if (!can(ctx.actor, "manage_settings", { practiceId: ctx.practiceId })) {
      throw data(null, { status: 403 });
    }
    const summary = await getImportRunSummary(
      db,
      ctx.practiceId,
      params.importRunId,
      { errorSampleLimit: IMPORT_RUN_ERROR_SAMPLE_CAP },
    );
    if (!summary) throw data(null, { status: 404 });
    const [draftInfo, duplicates] = await Promise.all([
      getImportRunDraftInfo(db, ctx.practiceId, params.importRunId),
      listSuspectedDuplicatesForImportRun(
        db,
        ctx.practiceId,
        params.importRunId,
      ),
    ]);

    const run = summary.run;
    const now = new Date();

    // Error table: sort by row number (stage-level failures sink to the
    // end in either direction), paginate server-side, and reconstruct the
    // ORIGINAL cell values for just the visible page from the run's batch
    // artifacts.
    const samples = run.errorSamples.map((sample) => ({
      sample,
      rowNumber: parseRowRef(sample.payloadRef),
    }));
    samples.sort((a, b) => {
      if (a.rowNumber === null && b.rowNumber === null) return 0;
      if (a.rowNumber === null) return 1;
      if (b.rowNumber === null) return -1;
      return sort === "asc"
        ? a.rowNumber - b.rowNumber
        : b.rowNumber - a.rowNumber;
    });
    const pageCount = Math.max(1, Math.ceil(samples.length / ERROR_PAGE_SIZE));
    const page = Math.min(
      Math.max(1, Number.isFinite(requestedPage) ? requestedPage : 1),
      pageCount,
    );
    const visible = samples.slice(
      (page - 1) * ERROR_PAGE_SIZE,
      page * ERROR_PAGE_SIZE,
    );
    const lookup = await readCsvBatchRows(
      context.cloudflare.env.RAW_ARTIFACTS,
      run.rawArtifactKeys,
      visible
        .map((entry) => entry.rowNumber)
        .filter((n): n is number => n !== null),
    );
    const errorRows: ErrorRow[] = visible.map(({ sample, rowNumber }) => ({
      rowNumber,
      reason:
        rowNumber !== null
          ? sample.message.replace(new RegExp(`^Row ${rowNumber}: `), "")
          : sample.message,
      values: rowNumber !== null ? (lookup.rows.get(rowNumber) ?? null) : null,
      stage: sample.stage,
      payloadRef: sample.payloadRef,
    }));

    const stale = isImportRunStale(run.status, run.startedAt, now);
    return {
      run: {
        id: run.id,
        status: run.status,
        stale,
        sourceLabel: SOURCE_KIND_LABELS[run.sourceKind],
        filename: draftInfo?.originalFilename ?? null,
        trigger: run.trigger,
        startedAtLabel: timeLabel(run.startedAt),
        finishedAtLabel:
          run.finishedAt === null ? null : timeLabel(run.finishedAt),
        durationLabel:
          summary.durationMs === null
            ? null
            : durationLabel(summary.durationMs),
        counts: {
          created: run.created,
          merged: run.merged,
          skipped: run.skipped,
          failed: run.failed,
          suspectedDuplicates: run.stats.suspected_duplicates ?? 0,
        },
        totalProcessed: summary.totalProcessed,
      },
      errors: {
        total: summary.errorCount,
        recorded: samples.length,
        unrecorded: Math.max(0, summary.errorCount - samples.length),
        rows: errorRows,
        headers: lookup.headers ?? null,
        page,
        pageCount,
        sort,
      },
      duplicates: duplicates.map((duplicate): DuplicateRow => {
        const side = (s: (typeof duplicate)["a"]): DuplicateSide => ({
          signalId: s.id,
          sourceLabel: SOURCE_KIND_LABELS[s.sourceKind],
          visibilityLabel: s.visibility === "public" ? "Public" : "Private",
          occurredOn: formatDate(s.occurredAt),
          snippet: snippet(s.text),
          fromThisRun: s.fromThisRun,
        });
        return {
          linkId: duplicate.link.id,
          status: duplicate.link.status,
          a: side(duplicate.a),
          b: side(duplicate.b),
        };
      }),
      failuresCsvUrl: `${(context.cloudflare.env.API_URL as string | undefined) ?? "http://localhost:8787"}/api/imports/runs/${run.id}/failures.csv`,
    };
  });
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div
      data-testid="stat-tile"
      className="flex flex-col gap-1 border border-hairline bg-surface-card px-4 py-3.5"
    >
      <span className="font-mono text-2xs uppercase tracking-label text-gray-500">
        {label}
      </span>
      <span className="text-2xl font-semibold tabular-nums text-ink-900">
        {value.toLocaleString("en-US")}
      </span>
    </div>
  );
}

function ValuesCell({
  values,
  headers,
}: {
  values: string[] | null;
  headers: string[] | null;
}) {
  const [expanded, setExpanded] = useState(false);
  if (values === null) {
    return <span className="text-small text-gray-500">Not recoverable</span>;
  }
  const joined = values.join(" · ");
  const long = joined.length > 120;
  return (
    <button
      type="button"
      onClick={() => long && setExpanded((current) => !current)}
      title={long ? (expanded ? "Collapse" : "Expand") : undefined}
      className={`m-0 block max-w-full border-0 bg-transparent p-0 text-left font-mono text-xs text-ink-800 ${
        long ? "cursor-pointer" : "cursor-text"
      }`}
    >
      {expanded && headers ? (
        <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
          {headers.map((header, i) => (
            <div key={header} className="contents">
              <dt className="text-gray-500">{header}</dt>
              <dd className="m-0 break-all">
                <code>{values[i] ?? ""}</code>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <code className={expanded ? "break-all" : "line-clamp-2 break-all"}>
          {joined}
        </code>
      )}
    </button>
  );
}

function ErrorTable({
  errors,
  searchParams,
}: {
  errors: Route.ComponentProps["loaderData"]["errors"];
  searchParams: URLSearchParams;
}) {
  if (errors.total === 0) {
    return (
      <p data-testid="errors-empty" className="m-0 text-small text-gray-600">
        Every row imported cleanly — nothing to fix.
      </p>
    );
  }
  const withParams = (patch: Record<string, string>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) next.set(key, value);
    return `?${next.toString()}`;
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-hairline">
              <th className="py-2 pr-4 align-bottom">
                <Link
                  to={withParams({
                    errors_sort: errors.sort === "asc" ? "desc" : "asc",
                    errors_page: "1",
                  })}
                  data-testid="errors-sort"
                  className="font-mono text-2xs font-medium uppercase tracking-label text-link no-underline"
                >
                  Row {errors.sort === "asc" ? "↑" : "↓"}
                </Link>
              </th>
              <th className="py-2 pr-4 align-bottom">
                <Overline>What went wrong</Overline>
              </th>
              <th className="py-2 align-bottom">
                <Overline>Original values</Overline>
              </th>
            </tr>
          </thead>
          <tbody>
            {errors.rows.map((row) => (
              <tr
                key={`${row.payloadRef}-${row.reason}`}
                data-testid="error-row"
                className="border-b border-hairline align-top"
              >
                <td className="py-2.5 pr-4 font-mono text-xs tabular-nums text-ink-800">
                  {row.rowNumber ?? "—"}
                </td>
                <td className="max-w-100 py-2.5 pr-4 text-small text-ink-900">
                  {row.reason}
                  {row.rowNumber === null && (
                    <span className="mt-1 block font-mono text-2xs text-gray-500">
                      [{row.stage}] <code>{row.payloadRef}</code>
                    </span>
                  )}
                </td>
                <td className="max-w-120 py-2.5">
                  <ValuesCell values={row.values} headers={errors.headers} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {errors.pageCount > 1 && (
        <div
          data-testid="errors-pagination"
          className="flex items-center gap-4 font-mono text-label font-medium uppercase tracking-label"
        >
          {errors.page > 1 && (
            <Link
              to={withParams({ errors_page: String(errors.page - 1) })}
              className="text-link"
            >
              Newer
            </Link>
          )}
          <span className="text-gray-500">
            Page {errors.page} of {errors.pageCount}
          </span>
          {errors.page < errors.pageCount && (
            <Link
              to={withParams({ errors_page: String(errors.page + 1) })}
              className="text-link"
            >
              Older
            </Link>
          )}
        </div>
      )}
      {errors.unrecorded > 0 && (
        <p
          data-testid="errors-cap-note"
          className="m-0 text-small text-gray-600"
        >
          {errors.unrecorded.toLocaleString("en-US")} additional failed{" "}
          {errors.unrecorded === 1 ? "row was" : "rows were"} counted but not
          individually recorded — only the first {IMPORT_RUN_ERROR_SAMPLE_CAP}{" "}
          failures keep details. The failures CSV states the same.
        </p>
      )}
    </div>
  );
}

function DuplicateCard({ duplicate }: { duplicate: DuplicateRow }) {
  const side = (s: DuplicateSide, label: string) => (
    <div className="min-w-0 flex-1">
      <p className="m-0 mb-1 font-mono text-2xs uppercase tracking-label text-gray-500">
        {label} · {s.sourceLabel} · {s.visibilityLabel} · {s.occurredOn}
        {s.fromThisRun ? " · this import" : ""}
      </p>
      <p className="m-0 font-mono text-quote text-ink-800">
        <Link
          to={`/signals/${s.signalId}`}
          className="text-inherit no-underline hover:underline"
        >
          {s.snippet}
        </Link>
      </p>
    </div>
  );
  return (
    <div
      data-testid="duplicate-row"
      className="flex flex-col gap-3 border-t border-hairline py-3.5 md:flex-row md:gap-6"
    >
      {side(duplicate.a, "Signal A")}
      {side(duplicate.b, "Signal B")}
    </div>
  );
}

export default function ImportRunReport({ loaderData }: Route.ComponentProps) {
  const { run, errors, duplicates, failuresCsvUrl } = loaderData;
  const [searchParams] = useSearchParams();
  useImportRunPolling(run.status === "running");

  return (
    <>
      <PageHeader
        overline="Settings · imports"
        title={run.filename ?? `${run.sourceLabel} import`}
        description={
          run.status === "running"
            ? run.stale
              ? "This import has been running unusually long. It may still finish — if nothing moves in the next hour, contact support and quote the report URL."
              : `Import in progress — ${run.totalProcessed.toLocaleString("en-US")} rows processed so far. This page updates automatically.`
            : "What this import did, row by row."
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <RunStatusBadge status={run.status} stale={run.stale} />
        <span className="font-mono text-label text-gray-500">
          {run.sourceLabel} · started {run.startedAtLabel}
          {run.finishedAtLabel
            ? ` · finished ${run.finishedAtLabel}${run.durationLabel ? ` (${run.durationLabel})` : ""}`
            : ""}
        </span>
      </div>

      <div className="flex max-w-220 flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <StatTile label="Created" value={run.counts.created} />
          <StatTile label="Merged" value={run.counts.merged} />
          <StatTile label="Skipped" value={run.counts.skipped} />
          <StatTile label="Failed" value={run.counts.failed} />
          <StatTile
            label="Possible duplicates"
            value={run.counts.suspectedDuplicates}
          />
        </div>

        <Card
          title={`Rows that couldn't be imported${errors.total > 0 ? ` (${errors.total.toLocaleString("en-US")})` : ""}`}
          action={
            errors.total > 0 ? (
              <a
                href={failuresCsvUrl}
                data-testid="failures-csv-link"
                className="font-mono text-label font-medium uppercase tracking-label text-link"
              >
                Download failures CSV
              </a>
            ) : undefined
          }
        >
          {errors.total > 0 && (
            <p className="m-0 mb-3.5 text-small text-gray-600">
              Fix exactly these rows in your spreadsheet and re-import the
              corrected file as a new upload.
            </p>
          )}
          <ErrorTable errors={errors} searchParams={searchParams} />
        </Card>

        <Card title={`Possible duplicates (${duplicates.length})`}>
          {duplicates.length === 0 ? (
            <p
              data-testid="duplicates-empty"
              className="m-0 text-small text-gray-600"
            >
              Nothing in this import looked like something you already had.
            </p>
          ) : (
            <>
              <p className="m-0 mb-2 text-small text-gray-600">
                These pairs look like the same feedback arriving twice. Nothing
                was merged — open either signal to compare and resolve.
              </p>
              {duplicates.map((duplicate) => (
                <DuplicateCard key={duplicate.linkId} duplicate={duplicate} />
              ))}
            </>
          )}
        </Card>

        <Card title="Timeline" sunken>
          <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-small">
            <dt className="font-mono text-2xs uppercase tracking-label text-gray-500">
              Started
            </dt>
            <dd className="m-0 text-ink-900">
              {run.startedAtLabel} (
              {run.trigger === "manual"
                ? "started by staff"
                : run.trigger === "cron"
                  ? "scheduled"
                  : "webhook"}
              )
            </dd>
            <dt className="font-mono text-2xs uppercase tracking-label text-gray-500">
              Finished
            </dt>
            <dd className="m-0 text-ink-900" data-testid="timeline-finished">
              {run.finishedAtLabel ??
                (run.stale
                  ? "Still marked running after 3+ hours — taking longer than expected"
                  : "Still running")}
            </dd>
          </dl>
        </Card>

        <p className="m-0 text-small text-gray-500">
          <Link to="/settings/imports" className="text-ink-900 underline">
            Back to imports
          </Link>
        </p>
      </div>
    </>
  );
}
