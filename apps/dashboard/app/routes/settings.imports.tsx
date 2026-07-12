// Settings → Imports (#137): the practice's import runs — date, source,
// trigger, status, counts — newest first, polling while anything is
// running, each row linking to the report page. The "New import" button
// (#133's upload screen, now at /settings/imports/new) lives here.
//
// TODO(#59): auth flows through requirePracticeContext (the demo-practice
// seam) until Epic #4 wires Clerk.
import { can, type ImportRunStatus } from "@wellregarded/core";
import { type ImportRun, listImportRuns } from "@wellregarded/db";
import { data, Link } from "react-router";

import {
  isImportRunStale,
  RunStatusBadge,
} from "~/components/imports/run-status";
import { useImportRunPolling } from "~/components/imports/use-run-polling";
import { Overline, PageHeader } from "~/components/shell/page-header";
import { formatAge, SOURCE_KIND_LABELS } from "~/components/signals/labels";
import { withRequestDb } from "~/lib/db.server";
import { requirePracticeContext } from "~/lib/practice-context.server";
import type { Route } from "./+types/settings.imports";

export function meta() {
  return [{ title: "Imports · Well Regarded" }];
}

const TRIGGER_LABELS: Record<ImportRun["trigger"], string> = {
  manual: "Manual",
  cron: "Scheduled",
  webhook: "Webhook",
};

/** Row view-model: display-ready strings only; dates format server-side. */
export interface ImportRunRow {
  id: string;
  startedAgo: string;
  sourceLabel: string;
  triggerLabel: string;
  status: ImportRunStatus;
  stale: boolean;
  countsSummary: string;
  failed: number;
}

function countsSummary(run: ImportRun): string {
  const parts = [
    `${run.created} created`,
    `${run.merged} merged`,
    `${run.skipped} skipped`,
  ];
  if (run.failed > 0) parts.push(`${run.failed} failed`);
  return parts.join(" · ");
}

function toRow(run: ImportRun, now: Date): ImportRunRow {
  return {
    id: run.id,
    startedAgo: formatAge(run.startedAt, now),
    sourceLabel: SOURCE_KIND_LABELS[run.sourceKind],
    triggerLabel: TRIGGER_LABELS[run.trigger],
    status: run.status,
    stale: isImportRunStale(run.status, run.startedAt, now),
    countsSummary: countsSummary(run),
    failed: run.failed,
  };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const cursor = new URL(request.url).searchParams.get("cursor");
  return withRequestDb(context, async (db) => {
    const ctx = await requirePracticeContext(db);
    if (!can(ctx.actor, "manage_settings", { practiceId: ctx.practiceId })) {
      throw data(null, { status: 403 });
    }
    const page = await listImportRuns(db, ctx.practiceId, {
      ...(cursor !== null ? { cursor } : {}),
    });
    const now = new Date();
    return {
      rows: page.runs.map((run) => toRow(run, now)),
      nextCursor: page.nextCursor ?? null,
      paginated: cursor !== null,
      anyRunning: page.runs.some(
        (run) =>
          run.status === "running" &&
          !isImportRunStale(run.status, run.startedAt, now),
      ),
    };
  });
}

function Row({ row }: { row: ImportRunRow }) {
  return (
    <Link
      to={`/settings/imports/runs/${row.id}`}
      data-testid="import-run-row"
      className="grid grid-cols-[90px_1fr] items-baseline gap-x-4 gap-y-1.5 border-t border-hairline py-3.5 text-inherit no-underline hover:bg-gray-50 md:grid-cols-[90px_140px_110px_1fr_max-content]"
    >
      <span className="font-mono text-label text-gray-500">
        {row.startedAgo}
      </span>
      <span className="text-small font-semibold text-ink-900">
        {row.sourceLabel}
      </span>
      <span className="font-mono text-label text-gray-500">
        {row.triggerLabel}
      </span>
      <span className="text-small text-gray-600">{row.countsSummary}</span>
      <span className="justify-self-start md:justify-self-end">
        <RunStatusBadge status={row.status} stale={row.stale} />
      </span>
    </Link>
  );
}

export default function Imports({ loaderData }: Route.ComponentProps) {
  const { rows, nextCursor, paginated, anyRunning } = loaderData;
  useImportRunPolling(anyRunning);

  return (
    <>
      <PageHeader
        overline="Settings · imports"
        title="Imports"
        description="Every import into this practice — what came in, what was skipped, and what needs fixing."
      />
      <div className="mb-5 flex items-center gap-3">
        <Link
          to="/settings/imports/new"
          className="inline-flex items-center border border-ink-900 bg-ink-900 px-4.5 py-3 font-mono text-xs font-semibold uppercase leading-none tracking-label text-on-dark no-underline hover:bg-ink-700"
        >
          New import
        </Link>
        <Link to="/settings" className="text-small text-ink-900 underline">
          Back to settings
        </Link>
      </div>
      {rows.length === 0 && !paginated ? (
        <div
          data-testid="imports-empty"
          className="flex flex-col items-center border border-hairline bg-surface-card px-8 py-16 text-center"
        >
          <h2 className="m-0 text-title font-semibold text-ink-900">
            Nothing imported yet
          </h2>
          <p className="mx-auto mt-2.5 mb-0 max-w-130 text-small text-gray-600">
            Bring past reviews and testimonials in from another system's CSV
            export — every import gets a report of what was created, merged, and
            skipped.
          </p>
        </div>
      ) : (
        <div className="flex flex-col">
          <div className="hidden grid-cols-[90px_140px_110px_1fr_max-content] gap-4 pb-2.5 md:grid">
            <Overline>Started</Overline>
            <Overline>Source</Overline>
            <Overline>Trigger</Overline>
            <Overline>Result</Overline>
            <Overline>Status</Overline>
          </div>
          {rows.map((row) => (
            <Row key={row.id} row={row} />
          ))}
        </div>
      )}
      {(nextCursor || paginated) && (
        <div className="mt-5 flex items-center gap-4 border-t border-hairline pt-4 font-mono text-label font-medium uppercase tracking-label">
          {paginated && (
            <Link to="/settings/imports" className="text-link">
              Back to latest
            </Link>
          )}
          {nextCursor && (
            <Link
              to={`/settings/imports?cursor=${encodeURIComponent(nextCursor)}`}
              className="text-link"
            >
              Older imports
            </Link>
          )}
        </div>
      )}
    </>
  );
}
