// Today (#95): the home screen, and a QUEUE, not a dashboard — only
// things that need a human's attention, each as one card with one clear
// action, in a strict priority order. When nothing needs attention the
// page says so warmly and stops: no charts, no stats strip, no activity
// feed. That emptiness is the product working.
import { can, describeResponseError } from "@wellregarded/core";
import {
  listFailedImports,
  listFailedPublishes,
  listNegativeReviewsNeedingResponse,
  listReauthConnections,
  listResponsesPendingApproval,
  listRunningImports,
  listUrgentSignals,
  type PracticeAiStatus,
  practiceAiStatus,
  TODAY_SECTION_LIMIT,
  type TodaySection as TodaySectionRows,
} from "@wellregarded/db";

import { EmptyState } from "~/components/empty-state";
import { PageHeader } from "~/components/shell/page-header";
import { formatAge, SOURCE_KIND_LABELS } from "~/components/signals/labels";
import {
  type TodayCardData,
  TodaySection,
  type TodaySectionData,
} from "~/components/today/today-card";
import { aiConfigEnv } from "~/lib/ai.server";
import { withRequestDb } from "~/lib/db.server";
import { requirePracticeContext } from "~/lib/practice-context.server";
import {
  SURFACES,
  surfaceIcon,
  surfaceTitle,
  todayOverline,
} from "~/lib/surfaces";
import type { Route } from "./+types/today";

const surface = SURFACES.today;

export function meta() {
  return [{ title: surfaceTitle(surface) }];
}

/** One calm line of a signal's own words for a card title. */
function excerpt(text: string | null, fallback: string): string {
  const collapsed = text?.replace(/\s+/g, " ").trim() ?? "";
  if (collapsed.length === 0) return fallback;
  return collapsed.length > 90
    ? `${collapsed.slice(0, 89).trimEnd()}…`
    : collapsed;
}

const emptySection = <T,>(): TodaySectionRows<T> => ({ items: [], total: 0 });

function more(
  section: TodaySectionRows<unknown>,
  to: string,
): TodaySectionData["more"] {
  const hidden =
    section.total - Math.min(section.items.length, TODAY_SECTION_LIMIT);
  return hidden > 0 ? { count: hidden, to } : null;
}

/**
 * The AI budget alert card (#75): ≥ 80% of the monthly cap is a heads-up
 * (caution); at 100% classification is deferring (negative) — both route
 * to Settings → AI. Reads the same `practiceAiStatus` the classify gate
 * and the settings banner use, so the three can never disagree.
 */
function aiBudgetCard(status: PracticeAiStatus): TodayCardData | null {
  if (status.budget.level === "ok") return null;
  const budgetCents = status.config.monthlyBudgetCents;
  const spend =
    budgetCents === null
      ? ""
      : `$${(status.spentCents / 100).toFixed(2)} of $${(budgetCents / 100).toFixed(2)} (estimated)`;
  const exhausted = status.budget.level === "exhausted";
  return {
    id: "ai-budget",
    tag: exhausted ? "AI budget reached" : "AI budget",
    tone: exhausted ? "negative" : "caution",
    title: exhausted
      ? "Monthly AI budget reached — classification is paused"
      : `AI spend has passed ${Math.floor(status.budget.ratio * 100)}% of this month's budget`,
    meta: exhausted
      ? `${spend} · urgent items still surface via the keyword fallback`
      : spend,
    cta: "Review AI settings",
    to: "/settings/ai",
  };
}

export async function loader({ context }: Route.LoaderArgs) {
  return withRequestDb(context, async (db) => {
    // TODO(#59): requirePracticeContext is the auth seam — see its module doc.
    const ctx = await requirePracticeContext(db);
    const allow = (action: Parameters<typeof can>[1]) =>
      can(ctx.actor, action, { practiceId: ctx.practiceId });

    // Permission-aware queue: a viewer only sees cards whose target
    // action they can take — connection/import cards route into settings
    // (manage_settings), review cards into the response flow
    // (draft_response). Urgent cards route to the signal detail, which
    // any staff viewer can open (private signals are gated in the query).
    const canManageSettings = allow("manage_settings");
    const canDraftResponse = allow("draft_response");
    // Failed publishes route to Retry and pending drafts to Approve —
    // both behind approve_response (#82 requirement 5).
    const canApproveResponse = allow("approve_response");

    // ONE Promise.all — every condition is queried concurrently, never a
    // waterfall (#95 requirement 6). Sections the viewer cannot act on
    // resolve to empty without a query.
    const [
      reauth,
      urgent,
      negative,
      failedImports,
      runningImports,
      failedPublishes,
      pendingApprovals,
      aiStatus,
    ] = await Promise.all([
      canManageSettings
        ? listReauthConnections(db, ctx.practiceId)
        : Promise.resolve([]),
      listUrgentSignals(db, {
        practiceId: ctx.practiceId,
        viewPrivateFeedback: ctx.viewer.viewPrivateFeedback,
      }),
      canDraftResponse
        ? listNegativeReviewsNeedingResponse(db, {
            practiceId: ctx.practiceId,
          })
        : Promise.resolve(emptySection<never>()),
      canManageSettings
        ? listFailedImports(db, { practiceId: ctx.practiceId })
        : Promise.resolve(emptySection<never>()),
      canManageSettings
        ? listRunningImports(db, { practiceId: ctx.practiceId })
        : Promise.resolve(emptySection<never>()),
      canApproveResponse
        ? listFailedPublishes(db, { practiceId: ctx.practiceId })
        : Promise.resolve(emptySection<never>()),
      canApproveResponse
        ? listResponsesPendingApproval(db, {
            practiceId: ctx.practiceId,
            excludeAuthorId: ctx.actor.staffId,
          })
        : Promise.resolve(emptySection<never>()),
      // AI budget state (#75) — the alert card routes into Settings → AI,
      // so it is gated like the other settings cards.
      canManageSettings
        ? practiceAiStatus(db, {
            practiceId: ctx.practiceId,
            env: aiConfigEnv(context.cloudflare.env),
          })
        : Promise.resolve(null),
    ]);
    const budgetCard = aiStatus ? aiBudgetCard(aiStatus) : null;

    // THE ordering (#95 requirement 3) — sections render in exactly this
    // order, each capped at TODAY_SECTION_LIMIT cards + an accurate
    // "N more →" link into the owning surface:
    //
    //   1. Connections needing re-auth — everything downstream silently
    //      degrades while a connection is broken.           (live)
    //   1b. AI budget alert (#75): ≥ 80% heads-up / 100% hard-stop —
    //      classification quality degrades while it stands. (live)
    //   2. Urgent unassigned recovery items (severity desc, oldest
    //      first). TODO(#122): `recovery_items` is Epic #15 and does not
    //      exist yet; until it lands this section surfaces the signals
    //      the route stage (#108) marked urgent — current urgency
    //      high/critical — so nothing rests unseen.       (interim)
    //   3. Failed imports.                                  (live)
    //   4. Overdue recovery items (most overdue first).
    //      TODO(#122): deferred with the same table.      (deferred)
    //   5. Failed publishes (#82) — loud, with Retry on the review's
    //      workflow surface; gated on approve_response.     (live)
    //   6. Responses pending MY approval (oldest first, #80) — gated on
    //      approve_response, the viewer's own drafts excluded. (live)
    //   7. Negative reviews needing response (oldest first) — the shared
    //      tier-1 predicate from @wellregarded/core.        (live)
    //   8. Running imports (informational, always last).    (live)
    const sections: TodaySectionData[] = [
      {
        key: "reauth",
        cards: reauth.map(
          (connection): TodayCardData => ({
            id: connection.id,
            tag: "Connection",
            tone: "negative",
            title: "Google connection needs re-authorization",
            meta: connection.lastSyncAt
              ? `Polling paused · last synced ${formatAge(connection.lastSyncAt)}`
              : "Polling paused until you reconnect",
            cta: "Reconnect",
            to: "/settings/integrations",
          }),
        ),
        more: null,
      },
      {
        key: "ai-budget",
        cards: budgetCard ? [budgetCard] : [],
        more: null,
      },
      {
        key: "urgent",
        cards: urgent.items.map(
          (signal): TodayCardData => ({
            id: signal.id,
            tag: `Urgent · ${signal.urgency}`,
            tone: signal.urgency === "critical" ? "negative" : "caution",
            title: excerpt(
              signal.text,
              `A ${SOURCE_KIND_LABELS[signal.sourceKind]} signal needs attention`,
            ),
            meta: `${SOURCE_KIND_LABELS[signal.sourceKind]} · ${formatAge(signal.occurredAt)}`,
            cta: "View signal",
            to: `/signals/${signal.id}`,
          }),
        ),
        // Pre-filtered overflow targets land with the recovery surface
        // (#122); the unified inbox filters by urgency in the meantime.
        more: more(urgent, "/signals?urgency=high"),
      },
      {
        key: "failed-imports",
        cards: failedImports.items.map(
          (run): TodayCardData => ({
            id: run.id,
            tag: "Import failed",
            tone: "negative",
            title: `${SOURCE_KIND_LABELS[run.sourceKind]} import failed`,
            meta: `${run.failed} failed · started ${formatAge(run.startedAt)}`,
            cta: "View imports",
            to: "/settings/imports",
          }),
        ),
        more: more(failedImports, "/settings/imports"),
      },
      {
        key: "failed-publishes",
        cards: failedPublishes.items.map(
          (publish): TodayCardData => ({
            id: publish.responseId,
            tag: "Publish failed",
            tone: "negative",
            title: excerpt(publish.body, "A response failed to publish"),
            meta: publish.errorDetail
              ? describeResponseError(publish.errorDetail)
              : `Failed ${formatAge(publish.failedAt)}`,
            cta: "Review & retry",
            to: `/reviews/${publish.signalId}`,
          }),
        ),
        // The inbox's pending_approval tab includes failed publishes
        // (approved-but-unpublished is still inside the human gate).
        more: more(failedPublishes, "/reviews?status=pending_approval"),
      },
      {
        key: "pending-approvals",
        cards: pendingApprovals.items.map(
          (pending): TodayCardData => ({
            id: pending.responseId,
            tag: "Awaiting approval",
            tone: "caution",
            title: excerpt(pending.body, "A response is awaiting approval"),
            meta: `${pending.authorName ?? "Staff member"} · waiting ${formatAge(pending.submittedAt)}`,
            cta: "Review & approve",
            to: `/reviews/${pending.signalId}`,
          }),
        ),
        more: more(pendingApprovals, "/reviews?status=pending_approval"),
      },
      {
        key: "negative-reviews",
        cards: negative.items.map(
          (review): TodayCardData => ({
            id: review.id,
            tag:
              review.rating !== null
                ? `${Number(review.rating)}-star review`
                : "Negative review",
            tone: "caution",
            title: excerpt(review.text, "A public review needs a response"),
            meta: `${SOURCE_KIND_LABELS[review.sourceKind]} · waiting ${formatAge(review.occurredAt)}`,
            cta: "Respond",
            // The review detail (#77); #79 mounts the composer into its
            // response-thread slot.
            to: `/reviews/${review.id}`,
          }),
        ),
        // /reviews defaults to needs-attention-first ordering (#76) —
        // exactly the overflow view.
        more: more(negative, "/reviews"),
      },
      {
        key: "running-imports",
        cards: runningImports.items.map(
          (run): TodayCardData => ({
            id: run.id,
            tag: "Import running",
            tone: "neutral",
            title: `${SOURCE_KIND_LABELS[run.sourceKind]} import in progress`,
            meta: `${run.created + run.merged + run.skipped + run.failed} processed so far · started ${formatAge(run.startedAt)}`,
            cta: "View imports",
            to: "/settings/imports",
          }),
        ),
        more: more(runningImports, "/settings/imports"),
      },
    ];

    return {
      overline: todayOverline(),
      sections: sections.filter((section) => section.cards.length > 0),
    };
  });
}

export default function Today({ loaderData }: Route.ComponentProps) {
  const { overline, sections } = loaderData;
  const empty = sections.length === 0;
  return (
    <>
      <PageHeader
        overline={overline}
        title={surface.title}
        description={surface.description}
      />
      {empty ? (
        // All clear — say so warmly and STOP. No placeholder tiles, no
        // stats, no suggestions (#95 requirement 5).
        <EmptyState
          icon={surfaceIcon(surface)}
          heading={surface.empty.heading}
          body={surface.empty.body}
        />
      ) : (
        <div className="flex max-w-3xl flex-col gap-6">
          {sections.map((section) => (
            <TodaySection key={section.key} section={section} />
          ))}
        </div>
      )}
    </>
  );
}
