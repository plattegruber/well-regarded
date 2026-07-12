// Today (#95): the home screen, and a QUEUE, not a dashboard — only
// things that need a human's attention, each as one card with one clear
// action, in a strict priority order. When nothing needs attention the
// page says so warmly and stops: no charts, no stats strip, no activity
// feed. That emptiness is the product working.
import { can } from "@wellregarded/core";
import {
  listFailedImports,
  listNegativeReviewsNeedingResponse,
  listReauthConnections,
  listRunningImports,
  listUrgentSignals,
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

    // ONE Promise.all — every condition is queried concurrently, never a
    // waterfall (#95 requirement 6). Sections the viewer cannot act on
    // resolve to empty without a query.
    const [reauth, urgent, negative, failedImports, runningImports] =
      await Promise.all([
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
      ]);

    // THE ordering (#95 requirement 3) — sections render in exactly this
    // order, each capped at TODAY_SECTION_LIMIT cards + an accurate
    // "N more →" link into the owning surface:
    //
    //   1. Connections needing re-auth — everything downstream silently
    //      degrades while a connection is broken.           (live)
    //   2. Urgent unassigned recovery items (severity desc, oldest
    //      first). TODO(#122): `recovery_items` is Epic #15 and does not
    //      exist yet; until it lands this section surfaces the signals
    //      the route stage (#108) marked urgent — current urgency
    //      high/critical — so nothing rests unseen.       (interim)
    //   3. Failed imports.                                  (live)
    //   4. Overdue recovery items (most overdue first).
    //      TODO(#122): deferred with the same table.      (deferred)
    //   5. Failed publishes. TODO(#82): the publish pipeline (Epic #10)
    //      has no storage yet; add `listFailedPublishes` when it lands.
    //                                                     (deferred)
    //   6. Responses pending MY approval (oldest first). TODO(#80): the
    //      `responses` table (Epic #10) does not exist yet; gate on
    //      approve_response and exclude the viewer's own drafts when it
    //      lands.                                         (deferred)
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
