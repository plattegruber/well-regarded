// Review detail (#77): everything the system knows about one public
// review, shown honestly — an AI inference is never presented as confirmed
// fact. Attribution renders "likely …" with a basis badge when it was
// inferred; derivations carry provenance and plain-language confidence
// (raw floats never reach the page); unclassified dimensions say so
// instead of faking neutrals.
//
// The response thread renders through ResponseThreadSlot — THE seam for
// #79's composer and #80's responses table (see that component's contract
// doc). Replies made directly at the source (Google's `reviewReply`) are
// captured by the adapter as `sourceMetadata.existingReply` on the wire
// contract (#125), but normalize (#104) deliberately does not persist them
// — the signals table has no source-metadata column — so this view cannot
// show them yet; the thread says so plainly for Google reviews rather than
// implying no reply exists anywhere.
import type {
  DerivationBasis,
  DerivationDimension,
  ReviewSourceKind,
  Sentiment,
} from "@wellregarded/core";
import {
  can,
  isNegativeReview,
  reviewStatusFromResponseState,
} from "@wellregarded/core";
import { getReviewDetail } from "@wellregarded/db";
import { data, Link } from "react-router";
import { ResponseWorkflowPanel } from "~/components/responses/response-workflow-panel";
import {
  REVIEW_SOURCE_TITLES,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_TONES,
} from "~/components/reviews/labels";
import { ResponseThreadSlot } from "~/components/reviews/response-thread-slot";
import { Overline, PageHeader } from "~/components/shell/page-header";
import { BasisBadge } from "~/components/signals/basis-badge";
import {
  DIMENSION_LABELS,
  formatDate,
  judgmentValueLabel,
  SOURCE_KIND_LABELS,
} from "~/components/signals/labels";
import { Badge } from "~/components/ui/badge";
import { Card } from "~/components/ui/card";
import { RatingStars } from "~/components/ui/rating-stars";
import { withRequestDb } from "~/lib/db.server";
import { requirePracticeContext } from "~/lib/practice-context.server";
import type { Route } from "./+types/reviews.$signalId";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function meta({ data: loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.title ?? "Review"} · Well Regarded` }];
}

/** One attributed entity (location or provider) as the view renders it. */
export interface AttributionView {
  /** Resolved FK — confident (exact or source-metadata match; #104). */
  name: string | null;
  /** Unresolved hint: render "likely {text}" + basis badge, never bare. */
  hint: { text: string; basis: DerivationBasis } | null;
}

const RESPONSE_DIMENSIONS: DerivationDimension[] = [
  "sentiment",
  "urgency",
  "response_risk",
];

export async function loader({ params, context }: Route.LoaderArgs) {
  if (!UUID_RE.test(params.signalId)) {
    throw data(null, { status: 404 });
  }
  return withRequestDb(context, async (db) => {
    // TODO(#59): requirePracticeContext is the auth seam — see its module
    // doc. Viewing public reviews is broad per the Epic #4 matrix; nothing
    // on this route exposes patient identity (getReviewDetail never joins
    // pii.patients), so no further gate applies here.
    const ctx = await requirePracticeContext(db);
    const { practiceId } = ctx;
    const detail = await getReviewDetail(db, {
      practiceId,
      signalId: params.signalId,
    });
    // Missing, cross-practice, private, and non-review all read the same:
    // 404 — existence is never disclosed.
    if (!detail) {
      throw data(null, { status: 404 });
    }

    const { signal } = detail;
    const sourceLabel = SOURCE_KIND_LABELS[signal.sourceKind];

    const derivationRow = (dimension: DerivationDimension) => {
      const row = detail.currentDerivations[dimension];
      return {
        dimension,
        label: DIMENSION_LABELS[dimension],
        value: row ? judgmentValueLabel(String(row.value)) : null,
        basis: row?.basis ?? null,
        confidence: row?.confidence ?? null,
        rationale: row?.rationale ?? null,
        judgedOn: row ? formatDate(row.createdAt) : null,
      };
    };

    return {
      // The detail query's predicate restricts source kinds; the cast
      // records that.
      title: REVIEW_SOURCE_TITLES[signal.sourceKind as ReviewSourceKind],
      overline: `Public review · ${sourceLabel}`,
      occurredOn: formatDate(signal.occurredAt),
      status: detail.status,
      review: {
        // The immutable original, rendered as-is (#77 requirement 2).
        originalText: signal.originalText,
        rating:
          detail.currentRating === null ? null : Number(detail.currentRating),
        sourceUrl: signal.sourceUrl,
        deletedAtSource: signal.availability === "deleted_at_source",
        edited: detail.edited,
        currentText: detail.edited ? detail.currentText : null,
      },
      attribution: {
        location: {
          name: detail.locationName,
          hint: detail.locationName === null ? signal.locationHint : null,
        },
        provider: {
          name: detail.providerName,
          hint: detail.providerName === null ? signal.providerHint : null,
        },
      } satisfies Record<string, AttributionView>,
      derivations: RESPONSE_DIMENSIONS.map(derivationRow),
      // Publication suitability sits behind a "more" disclosure (#77) —
      // it belongs to the proof workflow, not the response decision.
      publicationSuitability: derivationRow("publication_suitability"),
      highResponseRisk:
        detail.currentDerivations.response_risk?.value === "high",
      responses: detail.responses.map((entry) => ({
        id: entry.id,
        // Per-entry inbox-vocabulary chip (the page-level status reflects
        // only the newest entry).
        status: reviewStatusFromResponseState(entry.status),
        body: entry.body,
        authorName: entry.authorName,
        createdOn: formatDate(entry.createdAt),
        publishedOn: entry.publishedAt ? formatDate(entry.publishedAt) : null,
        publishedUrl: entry.publishedUrl,
      })),
      // The workflow panel (#80/#82): actions for the newest response,
      // mounted in the slot's composer seam; forms post to the responses
      // action route.
      workflow: (() => {
        const latest = detail.responses[0];
        const resource = { practiceId, locationId: detail.signal.locationId };
        const sentimentValue = detail.currentDerivations.sentiment?.value;
        return {
          latest: latest
            ? {
                id: latest.id,
                status: latest.status as
                  | "draft"
                  | "pending_approval"
                  | "approved"
                  | "published"
                  | "failed",
                isAuthor: latest.authorId === ctx.actor.staffId,
                rejectionComment: latest.rejectionComment,
                errorDetail: latest.errorDetail,
              }
            : null,
          canDraft: can(ctx.actor, "draft_response", resource),
          canApprove: can(ctx.actor, "approve_response", resource),
          // The SHARED negative predicate (reviews.ts) — same verdict as
          // the approval gate and the inbox tier-1 ordering.
          reviewIsNegative: isNegativeReview({
            rating:
              detail.currentRating === null
                ? null
                : Number(detail.currentRating),
            sentiment: (sentimentValue as Sentiment | undefined) ?? null,
          }),
          action: `/reviews/${params.signalId}/responses`,
        };
      })(),
      // Honesty note for sources that hold replies we do not capture yet
      // (see the module doc).
      responseSourceNote:
        signal.sourceKind === "google"
          ? "Replies posted directly on Google are not captured yet. This thread shows responses recorded in Well Regarded."
          : undefined,
      // TODO(Epic #15): "Related recovery item" card (#77 requirement 2) —
      // the recovery_items table does not exist yet; the section is
      // conditional and renders nothing until it lands.
    };
  });
}

function Attribution({
  label,
  view,
}: {
  label: string;
  view: AttributionView;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <Overline className="w-24">{label}</Overline>
      {view.name !== null ? (
        // A resolved FK: matched exactly or from source metadata (#104) —
        // renders plainly.
        <span className="font-mono text-data font-medium text-ink-900">
          {view.name}
        </span>
      ) : view.hint !== null ? (
        <>
          <span className="font-mono text-data text-ink-800">
            {`likely ${view.hint.text}`}
          </span>
          <BasisBadge basis={view.hint.basis} />
        </>
      ) : (
        <span className="font-mono text-data text-gray-500">Not recorded</span>
      )}
    </div>
  );
}

type DerivationView = Route.ComponentProps["loaderData"]["derivations"][number];

function DerivationRow({ row }: { row: DerivationView }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <Overline className="w-44">{row.label}</Overline>
      {row.value === null ? (
        <span className="font-mono text-data text-gray-500">
          Not yet classified
        </span>
      ) : (
        <>
          <span className="font-mono text-data font-medium text-ink-900">
            {row.value}
          </span>
          {row.basis !== null && row.confidence !== null && (
            <BasisBadge basis={row.basis} confidence={row.confidence} />
          )}
        </>
      )}
      {row.rationale && (
        <p className="m-0 w-full text-small text-gray-500">{row.rationale}</p>
      )}
    </div>
  );
}

export default function ReviewDetail({ loaderData }: Route.ComponentProps) {
  const d = loaderData;
  return (
    <>
      <Link
        to="/reviews"
        className="mb-4 inline-block font-mono text-label font-medium uppercase tracking-label text-link"
      >
        ← All reviews
      </Link>
      <PageHeader
        overline={d.overline}
        title={d.title}
        description={d.occurredOn}
        action={
          <span className="flex items-center gap-2">
            {d.highResponseRisk && (
              // The mockup's red-outlined marker: replying to this one is
              // easy to get wrong — read the derivation's rationale first.
              <span
                data-testid="response-risk"
                className="inline-flex items-center border border-red-700 px-2 py-1.25 font-mono text-2xs font-medium uppercase tracking-label text-red-700"
              >
                Response risk
              </span>
            )}
            <Badge tone={REVIEW_STATUS_TONES[d.status]}>
              {REVIEW_STATUS_LABELS[d.status]}
            </Badge>
          </span>
        }
      />

      <div className="grid items-start gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-5">
          {/* The review — immutable original, rendered verbatim. */}
          <Card title="Review" data-testid="review-text">
            <div className="flex flex-col gap-3">
              {d.review.rating !== null && (
                <RatingStars rating={d.review.rating} size={14} showValue />
              )}
              <p className="m-0 whitespace-pre-wrap font-mono text-quote text-ink-800">
                {d.review.originalText ?? "No text recorded."}
              </p>
              {d.review.currentText !== null && (
                <div className="border-t border-hairline pt-3">
                  <Overline className="mb-2">
                    Edited at the source — latest wording
                  </Overline>
                  <p className="m-0 whitespace-pre-wrap font-mono text-quote text-ink-800">
                    {d.review.currentText}
                  </p>
                </div>
              )}
              {d.review.deletedAtSource && (
                <p
                  className="m-0 border-t border-hairline pt-3 text-small text-gray-600"
                  data-testid="deleted-notice"
                >
                  This review was deleted at the source — the original is
                  preserved here.
                </p>
              )}
              {d.review.sourceUrl && (
                <a
                  href={d.review.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-label font-medium uppercase tracking-label text-link"
                >
                  View at source
                </a>
              )}
            </div>
          </Card>

          {/* Derivations — every judgment shows its provenance. */}
          <Card title="Derivations" data-testid="derivations-panel">
            <div className="flex flex-col gap-3.5">
              {d.derivations.map((row) => (
                <DerivationRow key={row.dimension} row={row} />
              ))}
              <details className="border-t border-hairline pt-3">
                <summary className="cursor-pointer list-none font-mono text-label font-medium uppercase tracking-label text-gray-600">
                  More
                </summary>
                <div className="pt-3">
                  <DerivationRow row={d.publicationSuitability} />
                </div>
              </details>
            </div>
          </Card>

          <ResponseThreadSlot
            entries={d.responses}
            sourceNote={d.responseSourceNote}
            // The workflow panel (#80/#82) mounts in the composer seam;
            // #79's compose form joins it here when it lands.
            composer={
              <ResponseWorkflowPanel
                latest={d.workflow.latest}
                canDraft={d.workflow.canDraft}
                canApprove={d.workflow.canApprove}
                reviewIsNegative={d.workflow.reviewIsNegative}
                action={d.workflow.action}
              />
            }
          />
        </div>

        <div className="flex flex-col gap-5">
          <Card title="Attribution" data-testid="attribution-panel">
            <div className="flex flex-col gap-3">
              <Attribution label="Location" view={d.attribution.location} />
              <Attribution label="Provider" view={d.attribution.provider} />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
