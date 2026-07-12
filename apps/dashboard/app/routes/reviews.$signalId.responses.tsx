// Response workflow for one review (issues #79/#80/#82, Epic #10): the
// response thread plus every mutation in the drafting-and-approval loop —
// the composer's draft-with-ai / safety-check / save-draft intents (#79),
// submit-for-approval (now with the compose-side safety gate), approve
// (with the fresh safety gate), reject-with-comment, and retry-publish.
//
// INTEGRATION: this route is THE action endpoint for the workflow. The
// review detail page (#77, /reviews/:signalId) mounts
// `<ResponseComposer>` (#79) and `<ResponseWorkflowPanel>` (#80/#82) in
// its `ResponseThreadSlot` composer seam and their fetcher forms POST
// here — the detail page needs no action plumbing of its own. The minimal
// page below remains as a focused workflow surface (full history +
// per-row actions via `<ResponseThread>`); the detail page is the primary
// UI.
//
// Action recipe per #141: permission check first, parse-don't-throw,
// mutate + audit in one transaction (`transitionResponse` /
// `createResponseDraft` / `updateResponseDraftBody` own both), then flash
// + redirect — except the fetcher-shaped composer intents and the safety
// bounces (422 data so findings + the acknowledgment checkbox render in
// place). State-machine denials map: conflict/invalid transition → 409,
// permission → 403, safety → 422, missing comment → 400.
//
// SAFETY, TWICE, ON PURPOSE (#79 requirement 5 / #80 requirement 6): the
// submit-for-approval edge re-runs `checkResponseSafety` on the text
// being submitted (the composer's disabled button is not the
// enforcement), and the approve edge re-runs it again on the text being
// approved. Findings are never persisted — stored findings go stale; only
// the draft text persists.
import {
  AiRequestError,
  AiResponseError,
  AiValidationError,
  checkResponseSafety,
  RESPONSE_DRAFT_PURPOSE,
  ResponseDraftSchema,
  responseDraftPrompt,
  type SafetyResult,
} from "@wellregarded/ai";
import {
  can,
  GBP_REPLY_MAX_BYTES,
  type PublishResponseMessage,
  type ResponseTransitionDenialCode,
  utf8ByteLength,
} from "@wellregarded/core";
import {
  createResponseDraft,
  getResponse,
  getResponseReviewContext,
  listResponsesForSignal,
  type ResponseReviewContext,
  type ReviewResponse,
  type TransitionResponseResult,
  transitionResponse,
  updateResponseDraftBody,
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
import { type ComposerSafetyResult, textHash } from "~/lib/safety-spans";
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

// One discriminated union instead of a flat shape: the composer intents
// (#79) carry a body and may not have a responseId yet; the workflow
// intents (#80/#82) always act on an existing row.
const intentSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("draft-with-ai") }),
  z.object({ intent: z.literal("safety-check"), body: z.string() }),
  z.object({
    intent: z.literal("save-draft"),
    body: z.string(),
    responseId: z.string().uuid().optional(),
  }),
  z.object({
    intent: z.literal("submit-for-approval"),
    // Optional pair: the composer sends body (creating the row on first
    // submit if needed); the workflow panel sends only responseId.
    responseId: z.string().uuid().optional(),
    body: z.string().optional(),
    acknowledgeWarnings: z.literal("yes").optional(),
  }),
  z.object({
    intent: z.literal("submit-and-approve"),
    responseId: z.string().uuid(),
    acknowledgeWarnings: z.literal("yes").optional(),
  }),
  z.object({
    intent: z.literal("approve"),
    responseId: z.string().uuid(),
    acknowledgeWarnings: z.literal("yes").optional(),
  }),
  z.object({
    intent: z.literal("reject"),
    responseId: z.string().uuid(),
    comment: z.string().optional(),
  }),
  z.object({
    intent: z.literal("retry-publish"),
    responseId: z.string().uuid(),
  }),
]);

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

/**
 * The composer-facing serialization: spans preserved (the highlight
 * overlay needs them) plus `checkedHash` of the exact text checked so the
 * client can discard stale results (#79 implementation notes).
 */
function toComposerSafety(
  safety: SafetyResult,
  checkedText: string,
): ComposerSafetyResult {
  return {
    level: safety.level,
    checkedHash: textHash(checkedText),
    findings: safety.findings.map((finding) => ({
      span: finding.span,
      code: finding.code,
      reason: finding.reason,
      suggestion: finding.suggestion,
      level: finding.level,
    })),
  };
}

/** Body validation shared by save and submit: non-empty, under the GBP cap. */
function bodyFieldErrors(body: string): Record<string, string[]> | null {
  if (body.trim() === "") {
    return { body: ["Write a reply before saving."] };
  }
  if (utf8ByteLength(body) > GBP_REPLY_MAX_BYTES) {
    return {
      body: [
        `Google caps replies at ${GBP_REPLY_MAX_BYTES} bytes — trim the reply.`,
      ],
    };
  }
  return null;
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
    const { intent } = parsed.data;

    // Every intent acts within one review — load it from the URL so the
    // composer intents (no responseId yet) are scoped exactly like the
    // workflow ones. Missing/cross-practice/private read the same: 404.
    const review = await getResponseReviewContext(
      db,
      ctx.practiceId,
      params.signalId,
    );
    if (review?.visibility !== "public") {
      throw data(null, { status: 404 });
    }
    const staff = staffFor(ctx, review);

    // Permission check in the action, always — hidden affordances are not a
    // security boundary. (canTransition re-checks; this is the early 403.)
    const draftSide =
      intent === "draft-with-ai" ||
      intent === "safety-check" ||
      intent === "save-draft" ||
      intent === "submit-for-approval";
    if (
      draftSide
        ? !staff.permissions.draftResponse
        : !staff.permissions.approveResponse
    ) {
      throw data(null, { status: 403 });
    }

    // Gated (#75): the practice kill switch / budget cap turns the Layer-2
    // call into an AiRequestError — safety checks degrade honestly to
    // deterministic-only, drafting surfaces the friendly paused message.
    const provider = getAiProvider(context.cloudflare.env, db, {
      practiceId: ctx.practiceId,
    });

    /** Full two-layer safety check for `body`, in this review's context. */
    const runSafety = (body: string) =>
      checkResponseSafety(
        body,
        {
          text: review.text,
          rating: review.rating,
          visibility: review.visibility,
        },
        {
          provider,
          practiceId: ctx.practiceId,
          requestId: context.requestId,
        },
      );

    /** Load + signal-scope-check a response id (404 on any mismatch). */
    const requireResponse = async (responseId: string) => {
      const row = await getResponse(db, ctx.practiceId, responseId);
      if (!row || row.signalId !== params.signalId) {
        throw data(null, { status: 404 });
      }
      return row;
    };

    switch (intent) {
      // --- Composer intents (#79) -----------------------------------------
      case "draft-with-ai": {
        // Sonnet via the drafting lane; inputs are the review text, its
        // rating, and the practice name — NEVER private context (see the
        // prompt module's input contract). The fresh draft's full safety
        // verdict rides back in the same response, so findings render the
        // moment the draft lands.
        try {
          const result = await provider.classify(
            responseDraftPrompt({
              reviewText: review.text,
              rating: review.rating,
              practiceName: ctx.practiceName,
            }),
            ResponseDraftSchema,
            {
              purpose: RESPONSE_DRAFT_PURPOSE,
              practiceId: ctx.practiceId,
              model: "drafting",
              requestId: context.requestId,
            },
          );
          const safety = await runSafety(result.value.draft);
          return data({
            draft: result.value.draft,
            safety: toComposerSafety(safety, result.value.draft),
          });
        } catch (error) {
          // Budget/kill-switch/config errors (#75) surface as a friendly
          // inline message — never a broken button. Drafting is optional;
          // writing a reply by hand is not.
          if (
            error instanceof AiRequestError ||
            error instanceof AiResponseError ||
            error instanceof AiValidationError
          ) {
            context.logger?.warn("responses.ai_draft_unavailable", {
              signalId: params.signalId,
              reason: error.name,
            });
            return data({
              aiUnavailable:
                "AI drafting is paused — you can still write a reply.",
            });
          }
          throw error;
        }
      }

      case "safety-check": {
        // The composer's debounced full check; #80's approve re-check uses
        // the same runSafety. Findings are returned, never persisted.
        const safety = await runSafety(parsed.data.body);
        return data({
          safety: toComposerSafety(safety, parsed.data.body),
        });
      }

      case "save-draft": {
        const fieldErrors = bodyFieldErrors(parsed.data.body);
        if (fieldErrors) return data({ fieldErrors }, { status: 422 });

        if (parsed.data.responseId) {
          await requireResponse(parsed.data.responseId);
          const saved = await updateResponseDraftBody(db, {
            practiceId: ctx.practiceId,
            responseId: parsed.data.responseId,
            body: parsed.data.body,
            actor: ctx.auditActor,
          });
          if (!saved) {
            // No longer a draft — someone submitted/approved meanwhile.
            return data(
              {
                error:
                  "This draft was already submitted — reload to see where it stands.",
              },
              { status: 409 },
            );
          }
          return data({ saved: { responseId: saved.id, body: saved.body } });
        }

        const created = await createResponseDraft(db, {
          practiceId: ctx.practiceId,
          signalId: params.signalId,
          authorId: ctx.actor.staffId,
          body: parsed.data.body,
          actor: ctx.auditActor,
        });
        return data({ saved: { responseId: created.id, body: created.body } });
      }

      case "submit-for-approval": {
        // Persist-then-check-then-transition. What gets checked is exactly
        // what was persisted; the composer's disabled button is UX, THIS is
        // the enforcement (#79 requirement 5, defense in depth).
        let response =
          parsed.data.responseId !== undefined
            ? await requireResponse(parsed.data.responseId)
            : undefined;

        const body = parsed.data.body ?? response?.body ?? "";
        const fieldErrors = bodyFieldErrors(body);
        if (fieldErrors) return data({ fieldErrors }, { status: 422 });

        if (!response) {
          response = await createResponseDraft(db, {
            practiceId: ctx.practiceId,
            signalId: params.signalId,
            authorId: ctx.actor.staffId,
            body,
            actor: ctx.auditActor,
          });
        } else if (
          parsed.data.body !== undefined &&
          parsed.data.body !== response.body
        ) {
          const saved = await updateResponseDraftBody(db, {
            practiceId: ctx.practiceId,
            responseId: response.id,
            body,
            actor: ctx.auditActor,
          });
          if (!saved) {
            return data(
              {
                error:
                  "This draft was already submitted — reload to see where it stands.",
              },
              { status: 409 },
            );
          }
          response = saved;
        }

        // The compose-side safety gate: block stops submission outright
        // (no waiver in the composer — blocks are edited away); warn
        // demands the explicit acknowledgment, same as the approve side.
        const acknowledged = parsed.data.acknowledgeWarnings === "yes";
        const safety = await runSafety(response.body);
        if (
          safety.level === "block" ||
          (safety.level === "warn" && !acknowledged)
        ) {
          return data(
            {
              safety: toComposerSafety(safety, response.body),
              saved: { responseId: response.id, body: response.body },
            },
            { status: 422 },
          );
        }

        const result = await transitionResponse(db, {
          practiceId: ctx.practiceId,
          responseId: response.id,
          to: "pending_approval",
          actor: ctx.auditActor,
          staff,
          // Recorded in the transition's audit row — the submit-side
          // verdict is part of the trail even though findings never persist.
          auditPayload: {
            safetyLevel: safety.level,
            warningsAcknowledged: acknowledged,
          },
        });
        if (!result.ok) return denialResponse(result);
        return redirectWithFlash(context, params.signalId, {
          tone: "positive",
          message: "Submitted for approval",
        });
      }

      // --- Workflow intents (#80/#82) --------------------------------------
      case "submit-and-approve": {
        // The non-negative fast path (#80 req 5): one click, still recorded
        // as two audited transitions. On a negative review the approve half
        // is structurally denied and the response stays pending_approval.
        // The approve half runs the fresh safety check, so the text is
        // gated exactly once on this path.
        const response = await requireResponse(parsed.data.responseId);
        const submitted = await transitionResponse(db, {
          practiceId: ctx.practiceId,
          responseId: response.id,
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

      case "approve": {
        const response = await requireResponse(parsed.data.responseId);
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
      }

      case "reject": {
        const response = await requireResponse(parsed.data.responseId);
        const comment = parsed.data.comment?.trim() ?? "";
        if (comment === "") {
          return data(
            { fieldErrors: { comment: ["A comment is required to reject."] } },
            { status: 400 },
          );
        }
        const result = await transitionResponse(db, {
          practiceId: ctx.practiceId,
          responseId: response.id,
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
        const response = await requireResponse(parsed.data.responseId);
        const result = await transitionResponse(db, {
          practiceId: ctx.practiceId,
          responseId: response.id,
          to: "approved",
          actor: ctx.auditActor,
          staff,
        });
        if (!result.ok) return denialResponse(result);
        const enqueued = await enqueuePublish(context, {
          responseId: response.id,
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
      // Gated (#75): kill switch / budget cap degrade the check to
      // deterministic-only via the provider's AiRequestError.
      provider: getAiProvider(context.cloudflare.env, db, {
        practiceId: ctx.practiceId,
      }),
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
