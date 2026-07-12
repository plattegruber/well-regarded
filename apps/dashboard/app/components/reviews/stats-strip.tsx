// Response-metrics stats strip (#86): three stat cards + ONE small trend
// line above the review inbox — response health at a glance, nothing
// more. Deliberately austere: the DS mono/tabular data treatment
// (font-mono text-data tabular-nums, per the styleguide), no chart
// library for one polyline, and honest sparse-data behavior (values render
// with a "small sample" hint instead of hiding).
//
// THE RULE (#86 requirement 3): response health is a quality signal, not
// a leaderboard. No per-staff-member metrics, no author names, no
// rankings — the view model deliberately has nowhere to put one. See the
// rationale in packages/db/src/queries/reviewResponseMetrics.ts.
//
// TODO(epic-17): when the /insights surface exists, this strip moves
// there and /reviews goes back to being purely the workspace.

/** Display-ready strings only — the loader formats server-side. */
export interface ReviewStatsData {
  /** e.g. "78%"; "—" when no reviews are in range. */
  responseRate: string;
  /** e.g. "1.5d"; "—" when nothing is responded yet. */
  medianResponse: string;
  /** Current unresponded backlog, e.g. "4". */
  unresponded: string;
  /** e.g. "↓ 2 vs last month"; null when there is no prior month signal. */
  unrespondedDelta: string | null;
  /** "down" is good news for a backlog. */
  unrespondedTone: "positive" | "negative" | "neutral";
  /** Monthly response rate, oldest → newest; null = no reviews that month. */
  trend: Array<{ month: string; rate: number | null }>;
  /** Fewer than 5 reviews in range (#86 requirement 5). */
  smallSample: boolean;
}

function StatCard({
  label,
  value,
  detail,
  detailTone = "neutral",
}: {
  label: string;
  value: string;
  detail?: string | null;
  detailTone?: "positive" | "negative" | "neutral";
}) {
  const detailColor =
    detailTone === "positive"
      ? "text-accent-700"
      : detailTone === "negative"
        ? "text-red-700"
        : "text-gray-500";
  return (
    <div className="flex min-w-36 flex-col gap-1 border border-hairline bg-surface-card px-4 py-3.5">
      <span className="font-mono text-2xs font-medium uppercase tracking-label text-gray-600">
        {label}
      </span>
      <span className="font-mono text-data font-semibold tabular-nums text-ink-900">
        {value}
      </span>
      {detail && (
        <span
          className={`font-mono text-2xs font-medium tabular-nums ${detailColor}`}
        >
          {detail}
        </span>
      )}
    </div>
  );
}

const CHART_W = 240;
const CHART_H = 56;
const PAD = 4;

/**
 * The one trend line (#86 requirement 2): monthly response rate as an
 * inline SVG polyline — months without reviews leave honest gaps rather
 * than fabricating zeros.
 */
function TrendLine({ trend }: { trend: ReviewStatsData["trend"] }) {
  const step = trend.length > 1 ? (CHART_W - PAD * 2) / (trend.length - 1) : 0;
  const points = trend
    .map((entry, index) =>
      entry.rate === null
        ? null
        : {
            x: PAD + index * step,
            y: PAD + (1 - entry.rate) * (CHART_H - PAD * 2),
            month: entry.month,
          },
    )
    .filter((point) => point !== null);
  const first = trend[0]?.month ?? "";
  const last = trend[trend.length - 1]?.month ?? "";

  return (
    <div className="flex min-w-60 flex-col gap-1 border border-hairline bg-surface-card px-4 py-3.5">
      <span className="font-mono text-2xs font-medium uppercase tracking-label text-gray-600">
        Response rate by month
      </span>
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="h-14 w-full"
        role="img"
        aria-label="Monthly response rate over the last 12 months"
        preserveAspectRatio="none"
      >
        {/* 0% / 100% guide hairlines. */}
        <line
          x1={PAD}
          x2={CHART_W - PAD}
          y1={PAD}
          y2={PAD}
          className="stroke-gray-200"
          strokeWidth="1"
          strokeDasharray="2 3"
        />
        <line
          x1={PAD}
          x2={CHART_W - PAD}
          y1={CHART_H - PAD}
          y2={CHART_H - PAD}
          className="stroke-gray-200"
          strokeWidth="1"
        />
        {points.length > 1 && (
          <polyline
            fill="none"
            className="stroke-accent-600"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={points.map((p) => `${p.x},${p.y}`).join(" ")}
          />
        )}
        {points.map((p) => (
          <circle
            key={p.month}
            cx={p.x}
            cy={p.y}
            r="2"
            className="fill-accent-600"
          />
        ))}
      </svg>
      <span className="flex justify-between font-mono text-2xs text-gray-500 tabular-nums">
        <span>{first}</span>
        <span>{last}</span>
      </span>
    </div>
  );
}

export function ReviewStatsStrip({ stats }: { stats: ReviewStatsData }) {
  return (
    <section
      aria-label="Response metrics"
      data-testid="review-stats"
      className="mb-5 flex flex-col gap-2"
    >
      <div className="flex flex-wrap gap-3">
        <StatCard label="Response rate" value={stats.responseRate} />
        <StatCard label="Median time to respond" value={stats.medianResponse} />
        <StatCard
          label="Unresponded"
          value={stats.unresponded}
          detail={stats.unrespondedDelta}
          detailTone={stats.unrespondedTone}
        />
        <TrendLine trend={stats.trend} />
      </div>
      {stats.smallSample && (
        <p className="m-0 font-mono text-2xs text-gray-500">
          Small sample — fewer than 5 reviews in the last 12 months; read these
          numbers loosely.
        </p>
      )}
    </section>
  );
}
