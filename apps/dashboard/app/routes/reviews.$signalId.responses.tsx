// Response workflow for one review (issues #80/#82, Epic #10): the
// response thread plus every workflow mutation — submit-for-approval,
// approve (with the fresh safety gate), reject-with-comment, and
// retry-publish.
//
// INTEGRATION: this route is THE action endpoint for the workflow. The
// review detail page (#77, /reviews/:signalId) mounts
// `<ResponseWorkflowPanel>` in its `ResponseThreadSlot` composer seam and
// its fetcher forms POST here — the detail page needs no action plumbing
// of its own. The composer (#79) wires its submit button to the
// `submit-for-approval` / `submit-and-approve` intents. The minimal page
// below remains as a focused workflow surface (full history + per-row
// actions via `<ResponseThread>`); the detail page is the primary UI.
//
// Action recipe per #141: permission check first, parse-don't-throw,
// mutate + audit in one transaction (`transitionResponse` owns both), then
// flash + redirect — except the approve bounce (fresh safety findings),
// which returns 422 data so the fetcher can render findings + the
// acknowledgment checkbox in place. State-machine denials map:
// conflict/invalid transition → 409, permission → 403, safety → 422,
// missing comment → 400.
import { checkResponseSafety, type SafetyResult } from "@wellregarded/ai";
import {
  can,
  type PublishResponseMessage,
  type ResponseTransitionDenialCode,
} from "@wellregarded/core";
import {
  getResponse,
  getResponseReviewContext,
  listResponsesForSignal,
  type ResponseReviewContext,
  type ReviewResponse,
  type TransitionResponseResult,
  transitionResponse,
} from "@wellregarded/db";
import { data, Link, redirect } from "react-router";
import { z } from "zod";

import { ResponseThread } from "~/components/responses/response-thread";
import type { SafetyNotice } from "~/components/responses/safety-findings";
import { Overline, PageHeader } from "~/components/shell/page-header";
import { formatDate } from "~/components/signals/labels";
import { Card } from "~/components/ui/card";
import { RatingStars } from "~/components/ui/rating-stars";
import { getAiProvider } from "~/lib/ai.server";
import { withRequestDb } from "~/lib/db.server";
import { setFlash } from "~/lib/flash.server";
import { parseForm } from "~/lib/forms.server";
import {
  type PracticeContext,
  requirePracticeContext,
} from "~/lib/practice-context.server";
import type { Route } from "./+types/reviews.$signalId.responses";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function meta() {
  return [{ title: "Review responses · Well Regarded" }];
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ params, context }: Route.LoaderArgs) {
  if (!UUID_RE.test(params.signalId)) {
    throw data(null, { status: 404 });
  }
  return withRequestDb(context, async (db) => {
    // TODO(#59): requirePracticeContext is the auth seam — see its module doc.
    const ctx = await requirePracticeContext(db);
    const review = await getResponseReviewContext(
      db,
      ctx.practiceId,
      params.signalId,
    );
    // Missing and cross-practice read the same: 404 (never leak existence).
    if (review?.visibility !== "public") {
      throw data(null, { status: 404 });
    }

    const rows = await listResponsesForSignal(
      db,
      ctx.practiceId,
      params.signalId,
    );
    const resource = {
      practiceId: ctx.practiceId,
      locationId: review.locationId,
    };

    return {
      review: {
        signalId: review.signalId,
        text: review.text,
        rating: review.rating === null ? null : Number(review.rating),
        sourceUrl: review.sourceUrl,
        isNegative: review.isNegative,
        deletedAtSource: review.availability === "deleted_at_source",
      },
      items: rows.map((row) => ({
        id: row.id,
        status: row.status,
        body: row.body,
        authorName: row.authorName ?? "Staff member",
        isAuthor: row.authorId === ctx.actor.staffId,
        createdOn: formatDate(row.createdAt),
        updatedOn: formatDate(row.updatedAt),
        rejectionComment: row.rejectionComment,
        errorDetail: row.errorDetail,
        moderationState: row.moderationState,
        publishedOn: row.publishedAt ? formatDate(row.publishedAt) : null,
      })),
      canDraft: can(ctx.actor, "draft_response", resource),
      canApprove: can(ctx.actor, "approve_response", resource),
    };
  });
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

const intentSchema = z.object({
  intent: z.enum([
    "submit-for-approval",
    "submit-and-approve",
    "approve",
    "reject",
    "retry-publish",
  ]),
  responseId: z.string().uuid(),
  comment: z.string().optional(),
  acknowledgeWarnings: z.literal("yes").optional(),
});

/** HTTP status for each state-machine denial (see canTransition's doc). */
const DENIAL_STATUS: Record<
  ResponseTransitionDenialCode | "not_found" | "conflict",
  number
> = {
  not_found: 404,
  conflict: 409,
  invalid_transition: 409,
  permission_denied: 403,
  system_only: 403,
  staff_only: 403,
  self_approval_negative: 403,
  safety_missing: 422,
  safety_block: 422,
  safety_unacknowledged: 422,
  comment_required: 400,
};

function denialResponse(
  result: Extract<TransitionResponseResult, { ok: false }>,
) {
  return data(
    { error: result.message, code: result.code },
    { status: DENIAL_STATUS[result.code] ?? 400 },
  );
}

function toSafetyNotice(
  safety: SafetyResult,
  acknowledged: boolean,
): SafetyNotice {
  return {
    level: safety.level,
    needsAcknowledgement: safety.level === "warn" && !acknowledged,
    findings: safety.findings.map((finding) => ({
      code: finding.code,
      reason: finding.reason,
      suggestion: finding.suggestion,
      level: finding.level,
    })),
  };
}

/** Best-effort enqueue: the binding is optional in local dev — an approved
 * row without a queue simply stays `approved`; Retry re-enqueues later. */
async function enqueuePublish(
  context: Route.ActionArgs["context"],
  message: PublishResponseMessage,
): Promise<boolean> {
  const queue = context.cloudflare.env.PUBLISH_RESPONSE_QUEUE as
    | Queue
    | undefined;
  if (!queue) {
    context.logger?.warn("responses.publish_queue_missing", {
      responseId: message.responseId,
    });
    return false;
  }
  await queue.send(message satisfies PublishResponseMessage);
  return true;
}

/** The staff slice `transitionResponse` needs, permissions scoped to the
 * review's location per the Epic #4 matrix. */
function staffFor(ctx: PracticeContext, review: ResponseReviewContext) {
  const resource = {
    practiceId: ctx.practiceId,
    locationId: review.locationId,
  };
  return {
    staffId: ctx.actor.staffId,
    permissions: {
      draftResponse: can(ctx.actor, "draft_response", resource),
      approveResponse: can(ctx.actor, "approve_response", resource),
    },
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (!UUID_RE.test(params.signalId)) {
    throw data(null, { status: 404 });
  }
  return withRequestDb(context, async (db) => {
    const ctx = await requirePracticeContext(db);

    const parsed = await parseForm(intentSchema, request);
    if (!parsed.ok) {
      return data({ fieldErrors: parsed.fieldErrors }, { status: 422 });
    }
    const { intent, responseId } = parsed.data;

    const response = await getResponse(db, ctx.practiceId, responseId);
    if (!response || response.signalId !== params.signalId) {
      throw data(null, { status: 404 });
    }
    const review = await getResponseReviewContext(
      db,
      ctx.practiceId,
      response.signalId,
    );
    if (!review) {
      throw data(null, { status: 404 });
    }
    const staff = staffFor(ctx, review);

    // Permission check in the action, always — hidden affordances are not a
    // security boundary. (canTransition re-checks; this is the early 403.)
    const needsApprove = intent !== "submit-for-approval";
    if (
      needsApprove
        ? !staff.permissions.approveResponse
        : !staff.permissions.draftResponse
    ) {
      throw data(null, { status: 403 });
    }

    switch (intent) {
      case "submit-for-approval": {
        const result = await transitionResponse(db, {
          practiceId: ctx.practiceId,
          responseId,
          to: "pending_approval",
          actor: ctx.auditActor,
          staff,
        });
        if (!result.ok) return denialResponse(result);
        return redirectWithFlash(context, params.signalId, {
          tone: "positive",
          message: "Submitted for approval",
        });
      }

      case "submit-and-approve": {
        // The non-negative fast path (#80 req 5): one click, still recorded
        // as two audited transitions. On a negative review the approve half
        // is structurally denied and the response stays pending_approval.
        const submitted = await transitionResponse(db, {
          practiceId: ctx.practiceId,
          responseId,
          to: "pending_approval",
          actor: ctx.auditActor,
          staff,
        });
        if (!submitted.ok) return denialResponse(submitted);
        return approve(
          db,
          context,
          ctx,
          params.signalId,
          submitted.response,
          review,
          staff,
          parsed.data.acknowledgeWarnings === "yes",
        );
      }

      case "approve":
        return approve(
          db,
          context,
          ctx,
          params.signalId,
          response,
          review,
          staff,
          parsed.data.acknowledgeWarnings === "yes",
        );

      case "reject": {
        const comment = parsed.data.comment?.trim() ?? "";
        if (comment === "") {
          return data(
            { fieldErrors: { comment: ["A comment is required to reject."] } },
            { status: 400 },
          );
        }
        const result = await transitionResponse(db, {
          practiceId: ctx.practiceId,
          responseId,
          to: "draft",
          actor: ctx.auditActor,
          staff,
          comment,
        });
        if (!result.ok) return denialResponse(result);
        return redirectWithFlash(context, params.signalId, {
          tone: "neutral",
          message: "Changes requested — the draft is back with its author",
        });
      }

      case "retry-publish": {
        const result = await transitionResponse(db, {
          practiceId: ctx.practiceId,
          responseId,
          to: "approved",
          actor: ctx.auditActor,
          staff,
        });
        if (!result.ok) return denialResponse(result);
        const enqueued = await enqueuePublish(context, {
          responseId,
          practiceId: ctx.practiceId,
          requestId: context.requestId,
        });
        return redirectWithFlash(context, params.signalId, {
          tone: enqueued ? "positive" : "neutral",
          message: enqueued
            ? "Retrying — publishing to Google"
            : "Approved for retry; publishing will start when the queue is available",
        });
      }
    }
  });
}

/**
 * The approve edge with the fresh safety gate (#80 requirement 6): re-run
 * `checkResponseSafety` on the CURRENT text (it may have changed since the
 * composer last checked), block on `block`, require the explicit
 * acknowledgment on `warn`, and record the verdict in the audit entry.
 * On success, enqueue the publish job (#82 requirement 1).
 */
async function approve(
  db: Parameters<typeof transitionResponse>[0],
  context: Route.ActionArgs["context"],
  ctx: PracticeContext,
  signalId: string,
  response: ReviewResponse,
  review: ResponseReviewContext,
  staff: ReturnType<typeof staffFor>,
  acknowledged: boolean,
) {
  const safety = await checkResponseSafety(
    response.body,
    { text: review.text, rating: review.rating, visibility: review.visibility },
    {
      provider: getAiProvider(context.cloudflare.env, db),
      practiceId: ctx.practiceId,
      requestId: context.requestId,
    },
  );
  const notice = toSafetyNotice(safety, acknowledged);
  if (safety.level === "block" || notice.needsAcknowledgement) {
    return data({ safety: notice }, { status: 422 });
  }

  const result = await transitionResponse(db, {
    practiceId: ctx.practiceId,
    responseId: response.id,
    to: "approved",
    actor: ctx.auditActor,
    staff,
    safety: { level: safety.level, warningsAcknowledged: acknowledged },
  });
  if (!result.ok) {
    if (
      result.code === "safety_block" ||
      result.code === "safety_unacknowledged"
    ) {
      return data({ safety: notice, error: result.message }, { status: 422 });
    }
    return denialResponse(result);
  }

  const enqueued = await enqueuePublish(context, {
    responseId: response.id,
    practiceId: ctx.practiceId,
    requestId: context.requestId,
  });
  return redirectWithFlash(context, signalId, {
    tone: "positive",
    message: enqueued
      ? "Approved — publishing to Google"
      : "Approved; publishing will start when the queue is available",
  });
}

async function redirectWithFlash(
  context: Route.ActionArgs["context"],
  signalId: string,
  flash: { tone: "positive" | "neutral"; message: string },
) {
  return redirect(`/reviews/${signalId}/responses`, {
    headers: await setFlash(context.cloudflare.env, flash),
  });
}

// ---------------------------------------------------------------------------
// Minimal standalone page — #77's detail page supersedes this as the
// primary surface; the loader/action above are the durable parts.
// ---------------------------------------------------------------------------

export default function ReviewResponses({ loaderData }: Route.ComponentProps) {
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
        overline="Public review · responses"
        title="Response workflow"
        description={
          d.review.isNegative
            ? "Negative review — approval by a second person is required."
            : undefined
        }
      />

      <div className="flex max-w-3xl flex-col gap-5">
        <Card title="Review">
          <div className="flex flex-col gap-3">
            {d.review.rating !== null && (
              <RatingStars rating={d.review.rating} size={14} showValue />
            )}
            <p className="m-0 whitespace-pre-wrap font-mono text-quote text-ink-800">
              {d.review.text ?? "No text recorded."}
            </p>
            {d.review.deletedAtSource && (
              <p className="m-0 border-t border-hairline pt-3 text-small text-gray-600">
                This review was deleted at the source — the original is
                preserved here. Replies can no longer be published.
              </p>
            )}
          </div>
        </Card>

        <Card title="Responses">
          <div className="flex flex-col gap-4">
            <Overline>History · newest first</Overline>
            <ResponseThread
              items={d.items}
              sourceUrl={d.review.sourceUrl}
              reviewIsNegative={d.review.isNegative}
              canDraft={d.canDraft}
              canApprove={d.canApprove}
            />
          </div>
        </Card>
      </div>
    </>
  );
}
