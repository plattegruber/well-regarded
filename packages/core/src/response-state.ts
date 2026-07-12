/**
 * The `responses` state machine (issue #80, Epic #10) and the publish-queue
 * message contract (issue #82).
 *
 * `canTransition` below is THE one place response-status transitions are
 * decided — route actions, the publish consumer (workers/jobs), and tests
 * all consult it through `transitionResponse` in `@wellregarded/db`, which
 * wraps it in a guarded UPDATE + audit row in one transaction. No code path
 * may UPDATE `responses.status` directly.
 *
 * The legal edges (issue #80 requirement 1 — nothing else, ever):
 *
 *   draft → pending_approval        (submit for approval)
 *   pending_approval → approved     (approve; safety gate + self-approval rules)
 *   pending_approval → draft        (reject — requires a comment)
 *   approved → published            (publish worker, #82 — system only)
 *   approved → failed               (publish error, #82 — system only)
 *   failed → approved               (manual retry re-queues, #82)
 *
 * Two rules are STRUCTURAL — encoded here, with no configuration escape
 * hatch:
 *
 * - **Negative reviews are always gated** (requirement 4): when the review
 *   is negative (rating ≤ {@link NEGATIVE_RATING_MAX}, or unrated with a
 *   negative current sentiment derivation — {@link isNegativeReview}), the
 *   approve edge requires an approver OTHER than the draft's author,
 *   regardless of role. There is no draft → published edge for anyone.
 * - **The safety gate re-runs at approve time** (requirement 6): the
 *   approve edge demands a fresh `checkResponseSafety` verdict in context.
 *   `block` denies; `warn` denies unless the approver explicitly
 *   acknowledged the warnings (recorded in the audit entry); a missing
 *   verdict denies (the gate cannot be skipped by not running it).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Statuses and edges
// ---------------------------------------------------------------------------

/** `responses.status` vocabulary (the `response_status` Postgres enum). */
export const RESPONSE_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "published",
  "failed",
] as const;

export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

// The negative-review predicate is `isNegativeReview` in ./reviews.ts —
// SHARED with #76's tier-1 inbox ordering so the approval gate and the
// inbox ordering can never drift. This module only consumes its verdict
// (`ResponseTransitionContext.reviewIsNegative`).

/**
 * Where a `responses` row came from. `dashboard` rows are the #80
 * workflow; `source_import` is reserved for #214 (pre-existing Google
 * replies imported as already-`published` rows, with no staff author —
 * hence `responses.author_id` is nullable). Text-typed, not a pg enum, so
 * #214 can extend the vocabulary without an ALTER TYPE migration.
 */
export const RESPONSE_ORIGINS = ["dashboard", "source_import"] as const;

export type ResponseOrigin = (typeof RESPONSE_ORIGINS)[number];

/**
 * The default `audit_log` action for each legal edge (`entity.verb` per the
 * audit convention). The publish worker overrides the `approved → *` edges
 * with the action from the GBP capability's audit event
 * (`response.published` / `response.publish_rejected` /
 * `response.publish_failed`) so one audit row records both the transition
 * and the Google outcome.
 */
export const RESPONSE_TRANSITION_AUDIT_ACTIONS: Readonly<
  Record<string, string>
> = {
  "draft->pending_approval": "response.submitted",
  "pending_approval->approved": "response.approved",
  "pending_approval->draft": "response.rejected",
  "approved->published": "response.published",
  "approved->failed": "response.publish_failed",
  "failed->approved": "response.retry_requested",
};

function edgeKey(from: ResponseStatus, to: ResponseStatus): string {
  return `${from}->${to}`;
}

// ---------------------------------------------------------------------------
// Transition context
// ---------------------------------------------------------------------------

/**
 * The two matrix permissions the state machine consults. Callers compute
 * them with `can()` against the review's practice/location resource — the
 * scoping rules stay in the permission matrix, not here.
 */
export interface ResponsePermissions {
  draftResponse: boolean;
  approveResponse: boolean;
}

/**
 * A fresh safety verdict for the approve edge (issue #80 requirement 6).
 * `level` is `SafetyResult["level"]` from `@wellregarded/ai` (structurally
 * identical; core does not depend on that package).
 */
export interface ResponseSafetyGate {
  level: "ok" | "warn" | "block";
  /**
   * The approver ticked the explicit "reviewed the warnings" checkbox.
   * Required when `level` is `warn`; recorded in the audit entry's payload,
   * never a column.
   */
  warningsAcknowledged: boolean;
}

/**
 * Everything `canTransition` needs to decide an edge. Pure data — callers
 * (i.e. `transitionResponse` in `@wellregarded/db`) load the response row,
 * the review's negativity, and the actor's permissions, then ask.
 */
export interface ResponseTransitionContext {
  /**
   * `staff_members.id` for staff actors; the worker/job name for system
   * actors (e.g. `jobs:publish-response`).
   */
  actorId: string;
  /**
   * Staff act through route actions; only the publish worker acts as
   * `system` (and only on the `approved → published|failed` edges).
   */
  actorType: "staff" | "system";
  /**
   * `responses.author_id` — the draft's author. Null only for
   * source-imported rows (#214), which never travel the approval edges.
   */
  authorId: string | null;
  /** Matrix permissions, computed by the caller via `can()`. */
  permissions: ResponsePermissions;
  /** See {@link isNegativeReview}. */
  reviewIsNegative: boolean;
  /** Fresh safety verdict — required for `pending_approval → approved`. */
  safety?: ResponseSafetyGate | undefined;
  /** Reject comment — required for `pending_approval → draft`. */
  rejectionComment?: string | undefined;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/** Why a transition was denied — the UI/HTTP mapping key. */
export type ResponseTransitionDenialCode =
  /** No such edge in the machine. Route actions map this (and stale-status races) to 409. */
  | "invalid_transition"
  /** The actor lacks the required matrix permission → 403. */
  | "permission_denied"
  /** Staff attempted a system-only edge (publish outcomes) → 403. */
  | "system_only"
  /** A system actor attempted a human edge → 403. */
  | "staff_only"
  /** Negative review: the author cannot approve their own draft → 403. */
  | "self_approval_negative"
  /** Approve without a fresh safety verdict — the gate cannot be skipped → 422. */
  | "safety_missing"
  /** The fresh safety check found block-level findings → 422. */
  | "safety_block"
  /** Warn-level findings without the explicit acknowledgment → 422. */
  | "safety_unacknowledged"
  /** Reject requires a non-empty comment → 400. */
  | "comment_required";

export type ResponseTransitionDecision =
  | {
      allowed: true;
      /** Default audit action for the edge (see {@link RESPONSE_TRANSITION_AUDIT_ACTIONS}). */
      auditAction: string;
    }
  | {
      allowed: false;
      code: ResponseTransitionDenialCode;
      /** Human-readable denial, safe to surface to staff. */
      message: string;
    };

function deny(
  code: ResponseTransitionDenialCode,
  message: string,
): ResponseTransitionDecision {
  return { allowed: false, code, message };
}

function allow(from: ResponseStatus, to: ResponseStatus) {
  const auditAction = RESPONSE_TRANSITION_AUDIT_ACTIONS[edgeKey(from, to)];
  // Unreachable by construction — every legal edge has an action.
  if (auditAction === undefined) {
    throw new Error(`no audit action for edge ${edgeKey(from, to)}`);
  }
  return { allowed: true, auditAction } as const;
}

/**
 * THE response-status transition decision (issue #80 requirement 1). Pure
 * and exhaustive; returns a decision, never throws. Callers translate
 * denials: `invalid_transition` (and 0-row guarded updates) → 409,
 * permission denials → 403, safety denials → 422, `comment_required` → 400.
 */
export function canTransition(
  from: ResponseStatus,
  to: ResponseStatus,
  ctx: ResponseTransitionContext,
): ResponseTransitionDecision {
  switch (edgeKey(from, to)) {
    case "draft->pending_approval": {
      if (ctx.actorType !== "staff")
        return deny("staff_only", "Only staff can submit a draft.");
      if (!ctx.permissions.draftResponse)
        return deny(
          "permission_denied",
          "You don't have permission to submit responses for approval.",
        );
      return allow(from, to);
    }

    case "pending_approval->approved": {
      if (ctx.actorType !== "staff")
        return deny("staff_only", "Only staff can approve a response.");
      if (!ctx.permissions.approveResponse)
        return deny(
          "permission_denied",
          "You don't have permission to approve responses.",
        );
      // STRUCTURAL (requirement 4): negative reviews need a second person.
      if (
        ctx.reviewIsNegative &&
        ctx.authorId !== null &&
        ctx.actorId === ctx.authorId
      )
        return deny(
          "self_approval_negative",
          "Responses to negative reviews must be approved by someone other than the author.",
        );
      // STRUCTURAL (requirement 6): a fresh safety verdict is mandatory.
      if (ctx.safety === undefined)
        return deny(
          "safety_missing",
          "The safety check must run on the current text before approval.",
        );
      if (ctx.safety.level === "block")
        return deny(
          "safety_block",
          "The safety check found blocking findings — the draft must be edited before it can be approved.",
        );
      if (ctx.safety.level === "warn" && !ctx.safety.warningsAcknowledged)
        return deny(
          "safety_unacknowledged",
          "The safety check found warnings — confirm you reviewed them to approve.",
        );
      return allow(from, to);
    }

    case "pending_approval->draft": {
      if (ctx.actorType !== "staff")
        return deny("staff_only", "Only staff can reject a response.");
      if (!ctx.permissions.approveResponse)
        return deny(
          "permission_denied",
          "You don't have permission to reject responses.",
        );
      if (
        ctx.rejectionComment === undefined ||
        ctx.rejectionComment.trim() === ""
      )
        return deny(
          "comment_required",
          "Rejecting a response requires a comment explaining what to change.",
        );
      return allow(from, to);
    }

    case "approved->published":
    case "approved->failed": {
      // Publish outcomes are the worker's to record (issue #82) — staff
      // never write them, not even owners.
      if (ctx.actorType !== "system")
        return deny(
          "system_only",
          "Publish outcomes are recorded by the publish worker.",
        );
      return allow(from, to);
    }

    case "failed->approved": {
      // Manual retry (issue #82 requirement 5): same permission as approve.
      if (ctx.actorType !== "staff")
        return deny("staff_only", "Only staff can retry a failed publish.");
      if (!ctx.permissions.approveResponse)
        return deny(
          "permission_denied",
          "You don't have permission to retry publishing.",
        );
      return allow(from, to);
    }

    default:
      return deny(
        "invalid_transition",
        `A response cannot go from ${from} to ${to}.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Publish outcome detail (issue #82)
// ---------------------------------------------------------------------------

/** GBP reply moderation states (2026 moderation; mirrors `GbpReplyState`
 * in `@wellregarded/sources` — this package must not depend on it). */
export const RESPONSE_MODERATION_STATES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
] as const;

export type ResponseModerationState =
  (typeof RESPONSE_MODERATION_STATES)[number];

/**
 * What `responses.error_detail` persists for a failed publish. The first
 * three arms are `ReplyErrorDetail` from `@wellregarded/sources` verbatim
 * (the issue-#127 contract; `reason` widened to string so this package
 * stays decoupled); `moderation_rejected` is the synchronous-REJECTED
 * outcome — Google refused the content, a human must rewrite it, retrying
 * is pointless.
 */
export type ResponseErrorDetail =
  | {
      kind: "transient_exhausted";
      lastStatus?: number;
      message: string;
      at: string;
    }
  | {
      kind: "permanent";
      reason: string;
      status?: number;
      googleStatus?: string;
      message: string;
      at: string;
    }
  | { kind: "needs_reauth"; at: string }
  | {
      kind: "moderation_rejected";
      policyViolation?: string;
      message: string;
      at: string;
    };

/**
 * Error class for surfacing/retry decisions (issue #82 requirement 6):
 * `auth` failures don't burn retries and point at the re-auth surface;
 * `transient` is the only class the Retry button is expected to fix
 * without edits; `content` needs a rewrite; `permanent` needs a human look.
 */
export type ResponseErrorClass = "auth" | "transient" | "content" | "permanent";

export function responseErrorClass(
  detail: ResponseErrorDetail,
): ResponseErrorClass {
  switch (detail.kind) {
    case "needs_reauth":
      return "auth";
    case "transient_exhausted":
      return "transient";
    case "moderation_rejected":
      return "content";
    case "permanent":
      return "permanent";
  }
}

/** One-line human description of a publish failure, for chips and cards. */
export function describeResponseError(detail: ResponseErrorDetail): string {
  switch (detail.kind) {
    case "needs_reauth":
      return "Google connection needs re-authorization — reconnect in Settings → Integrations, then retry.";
    case "transient_exhausted":
      return `Google kept failing (${detail.message}). Retrying usually fixes this.`;
    case "moderation_rejected":
      return detail.policyViolation
        ? `Google rejected the reply (${detail.policyViolation}). Edit the text and resubmit.`
        : "Google rejected the reply under its content policy. Edit the text and resubmit.";
    case "permanent":
      if (detail.reason === "review_not_found")
        return "This review no longer exists on Google — the reply cannot be published.";
      if (detail.reason === "location_unverified")
        return "Google blocks replies on unverified locations. Re-verify the location, then retry.";
      return `Google rejected the request: ${detail.message}`;
  }
}

// ---------------------------------------------------------------------------
// Publish queue contract (issue #82)
// ---------------------------------------------------------------------------

/**
 * Queue-name prefix for the publish queue, `wr-publish-response[-<env>]`
 * (naming per infra/environments.md). Produced by the dashboard's approve
 * and retry actions; consumed by workers/jobs (which owns the GBP OAuth
 * secrets and token provider).
 */
export const PUBLISH_RESPONSE_QUEUE_PREFIX = "wr-publish-response";

/** Is this `batch.queue` the publish-response queue (any environment)? */
export function isPublishResponseQueue(queueName: string): boolean {
  return /^wr-publish-response(?:-(preview|prod))?$/.test(queueName);
}

/**
 * The publish-queue message: ids only (the consumer re-reads the row —
 * message content can't go stale in flight), plus the propagated trace id.
 */
export const publishResponseMessageSchema = z.object({
  responseId: z.uuid(),
  practiceId: z.uuid(),
  /** Trace id (issue #64). Producers MUST set it; consumers backfill. */
  requestId: z.string().min(1).optional(),
});

export type PublishResponseMessage = z.infer<
  typeof publishResponseMessageSchema
>;

/**
 * Delivery budget for one publish message (issue #82 requirement 4): the
 * consumer treats delivery `attempts >= PUBLISH_RESPONSE_MAX_DELIVERIES`
 * as final and marks the row `failed` instead of retrying again. Keep in
 * sync with the queue's `max_retries` (deliveries = max_retries + 1) in
 * workers/jobs/wrangler.jsonc.
 */
export const PUBLISH_RESPONSE_MAX_DELIVERIES = 3;

/**
 * Backoff before redelivery `attempt + 1`, in seconds — exponential via the
 * queue's per-message retry delay. Indexed by the just-failed attempt
 * (1-based); the last entry repeats.
 */
export const PUBLISH_RESPONSE_RETRY_DELAY_SECONDS = [60, 300] as const;

export function publishResponseRetryDelaySeconds(attempt: number): number {
  const index = Math.max(0, attempt - 1);
  return (
    PUBLISH_RESPONSE_RETRY_DELAY_SECONDS[index] ??
    PUBLISH_RESPONSE_RETRY_DELAY_SECONDS[
      PUBLISH_RESPONSE_RETRY_DELAY_SECONDS.length - 1
    ] ??
    300
  );
}
