/**
 * `responses` queries — the approval workflow's one write path (issues
 * #80/#82, Epic #10).
 *
 * `transitionResponse` is THE way `responses.status` changes: it loads the
 * row and its review context, asks the pure `canTransition` in
 * `@wellregarded/core`, then applies a guarded
 * `UPDATE … WHERE status = <from>` and the `audit_log` row in ONE
 * transaction. A 0-row guarded update means someone else acted first —
 * returned as a `conflict`, which route actions render as 409 ("someone
 * else acted on this"). Direct UPDATEs of `status` anywhere else are a bug.
 *
 * The publish consumer (workers/jobs) uses the same function for the
 * `approved → published|failed` edges, passing the GBP capability's audit
 * event as `auditAction`/`auditPayload` so ONE audit row records both the
 * transition and the Google outcome (the issue-#127 seam contract: the
 * caller maps the capability event to `audit_log`, adding the practice id,
 * in the same transaction as the `responses` write).
 */

import type { Actor, Sentiment } from "@wellregarded/core";
import {
  canTransition,
  isNegativeReview,
  type ResponseErrorDetail,
  type ResponseModerationState,
  type ResponsePermissions,
  type ResponseSafetyGate,
  type ResponseStatus,
  type ResponseTransitionDenialCode,
  SENTIMENTS,
} from "@wellregarded/core";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";

import { audit, type Tx } from "../audit.js";
import type { Db } from "../client.js";
import { signalVersions } from "../schema/dedupe.js";
import { responses } from "../schema/responses.js";
import { signals } from "../schema/signals.js";
import { staffMembers } from "../schema/tenancy.js";
import { getCurrentDerivations } from "./derivations.js";
import { TODAY_SECTION_LIMIT, type TodaySection } from "./today.js";

export type ReviewResponse = typeof responses.$inferSelect;

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export interface CreateResponseDraftInput {
  practiceId: string;
  signalId: string;
  /** `staff_members.id` of the author. */
  authorId: string;
  body: string;
  /** Audit actor (normally the author's staff actor). */
  actor: Actor;
}

/**
 * Create a `draft` response row, audited (`response.drafted`) in the same
 * transaction. The composer (#79) owns richer draft lifecycle (autosave,
 * updates); this is the seam it and tests create rows through.
 */
export async function createResponseDraft(
  db: Db,
  input: CreateResponseDraftInput,
): Promise<ReviewResponse> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(responses)
      .values({
        practiceId: input.practiceId,
        signalId: input.signalId,
        authorId: input.authorId,
        body: input.body,
      })
      .returning();
    if (!row) throw new Error("response insert returned no row");
    await audit(tx, {
      practiceId: input.practiceId,
      actor: input.actor,
      action: "response.drafted",
      entityType: "responses",
      entityId: row.id,
      payload: { signalId: input.signalId },
    });
    return row;
  });
}

/** One response by id, practice-scoped. */
export async function getResponse(
  db: Db | Tx,
  practiceId: string,
  responseId: string,
): Promise<ReviewResponse | undefined> {
  const [row] = await db
    .select()
    .from(responses)
    .where(
      and(eq(responses.id, responseId), eq(responses.practiceId, practiceId)),
    )
    .limit(1);
  return row;
}

/** A thread row: the response plus its author's display name. */
export type ResponseThreadRow = ReviewResponse & { authorName: string | null };

/** The #77 response thread: all responses for a signal, newest first. */
export async function listResponsesForSignal(
  db: Db,
  practiceId: string,
  signalId: string,
): Promise<ResponseThreadRow[]> {
  const rows = await db
    .select({ response: responses, authorName: staffMembers.displayName })
    .from(responses)
    .leftJoin(staffMembers, eq(staffMembers.id, responses.authorId))
    .where(
      and(
        eq(responses.signalId, signalId),
        eq(responses.practiceId, practiceId),
      ),
    )
    .orderBy(desc(responses.createdAt));
  return rows.map((row) => ({ ...row.response, authorName: row.authorName }));
}

// ---------------------------------------------------------------------------
// Review context (negativity + publish inputs)
// ---------------------------------------------------------------------------

/** What the state machine and publish consumer need to know about the review. */
export interface ResponseReviewContext {
  signalId: string;
  sourceKind: string;
  /** The source's native id (the GBP v4 review resource name for google). */
  sourceId: string | null;
  sourceUrl: string | null;
  availability: string;
  visibility: "public" | "private";
  locationId: string | null;
  /** Current text (latest version if edited at source, else original). */
  text: string | null;
  /** Current rating on the source's scale (numeric string). */
  rating: string | null;
  /** Current sentiment derivation value, when classified. */
  sentiment: Sentiment | null;
  /** The issue-#80 structural predicate, computed from the two above. */
  isNegative: boolean;
}

/**
 * Load the review context for a signal: current content (version-aware),
 * current sentiment derivation, and the negativity predicate.
 */
export async function getResponseReviewContext(
  db: Db | Tx,
  practiceId: string,
  signalId: string,
): Promise<ResponseReviewContext | undefined> {
  const [row] = await db
    .select({
      signalId: signals.id,
      sourceKind: signals.sourceKind,
      sourceId: signals.sourceId,
      sourceUrl: signals.sourceUrl,
      availability: signals.availability,
      visibility: signals.visibility,
      locationId: signals.locationId,
      originalText: signals.originalText,
      originalRating: signals.originalRating,
      versionText: signalVersions.content,
      versionRating: signalVersions.rating,
      currentVersionId: signals.currentVersionId,
    })
    .from(signals)
    .leftJoin(signalVersions, eq(signalVersions.id, signals.currentVersionId))
    .where(and(eq(signals.id, signalId), eq(signals.practiceId, practiceId)))
    .limit(1);
  if (!row) return undefined;

  const current = await getCurrentDerivations(db as Db, signalId);
  const sentimentValue = current.sentiment
    ? String(current.sentiment.value)
    : null;
  const sentiment = (SENTIMENTS as readonly string[]).includes(
    sentimentValue ?? "",
  )
    ? (sentimentValue as Sentiment)
    : null;
  const rating =
    row.currentVersionId !== null && row.versionRating !== null
      ? row.versionRating
      : row.originalRating;
  const text =
    row.currentVersionId !== null && row.versionText !== null
      ? row.versionText
      : row.originalText;

  return {
    signalId: row.signalId,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    sourceUrl: row.sourceUrl,
    availability: row.availability,
    visibility: row.visibility,
    locationId: row.locationId,
    text,
    rating,
    sentiment,
    // The SHARED predicate from @wellregarded/core (reviews.ts) — same
    // verdict as #76's inbox tier-1 ordering, so they cannot drift.
    isNegative: isNegativeReview({
      rating: rating === null ? null : Number(rating),
      sentiment,
    }),
  };
}

// ---------------------------------------------------------------------------
// The transition
// ---------------------------------------------------------------------------

/** Publish-outcome columns a transition may set (system edges, #82). */
export interface ResponsePublishPatch {
  errorDetail?: ResponseErrorDetail | null;
  moderationState?: ResponseModerationState | null;
  policyViolation?: string | null;
  publishedAt?: Date | null;
  publishUpdateTime?: string | null;
}

export interface TransitionResponseInput {
  practiceId: string;
  responseId: string;
  to: ResponseStatus;
  /**
   * Audit actor. `staff` actors must also pass `staff` (matrix permissions
   * computed by the caller via `can()` against the review's location);
   * `system` actors are the publish worker.
   */
  actor: Actor;
  staff?: {
    staffId: string;
    permissions: ResponsePermissions;
  };
  /** Fresh safety verdict — required for the approve edge (issue #80 req 6). */
  safety?: ResponseSafetyGate;
  /** Reject comment — required for the reject edge. */
  comment?: string;
  /** Publish-outcome columns (system edges only). */
  patch?: ResponsePublishPatch;
  /**
   * Override the edge's default audit action — the publish consumer passes
   * the GBP capability event's action (`response.published` /
   * `response.publish_rejected` / `response.publish_failed`).
   */
  auditAction?: string;
  /** Extra non-PII audit context, merged into the payload. */
  auditPayload?: Record<string, unknown>;
  /**
   * Also flip the signal's `availability` to `deleted_at_source` in the
   * same transaction (the 404 `review_not_found` contract from #127).
   */
  markSignalDeletedAtSource?: boolean;
}

export type TransitionResponseResult =
  | { ok: true; response: ReviewResponse }
  | {
      ok: false;
      code: "not_found" | "conflict" | ResponseTransitionDenialCode;
      message: string;
    };

/**
 * Apply one state-machine transition: load → `canTransition` → guarded
 * UPDATE + audit in one transaction. Never throws for workflow outcomes —
 * denials, missing rows, and races come back as typed results the caller
 * maps to HTTP statuses (409 for `conflict`/`invalid_transition`, 403 for
 * permission denials, 422 for safety denials, 400 for `comment_required`).
 */
export async function transitionResponse(
  db: Db,
  input: TransitionResponseInput,
): Promise<TransitionResponseResult> {
  return db.transaction(async (tx) => {
    const response = await getResponse(tx, input.practiceId, input.responseId);
    if (!response) {
      return {
        ok: false as const,
        code: "not_found" as const,
        message: "Response not found.",
      };
    }

    const review = await getResponseReviewContext(
      tx,
      input.practiceId,
      response.signalId,
    );
    if (!review) {
      return {
        ok: false as const,
        code: "not_found" as const,
        message: "The response's review no longer exists.",
      };
    }

    const decision = canTransition(response.status, input.to, {
      actorId:
        input.actor.type === "staff" || input.actor.type === "system"
          ? input.actor.id
          : input.actor.jti,
      actorType: input.actor.type === "system" ? "system" : "staff",
      authorId: response.authorId,
      permissions: input.staff?.permissions ?? {
        draftResponse: false,
        approveResponse: false,
      },
      reviewIsNegative: review.isNegative,
      safety: input.safety,
      rejectionComment: input.comment,
    });
    if (!decision.allowed) {
      return {
        ok: false as const,
        code: decision.code,
        message: decision.message,
      };
    }

    const patch = input.patch ?? {};
    const [updated] = await tx
      .update(responses)
      .set({
        status: input.to,
        updatedAt: new Date(),
        // Reject stores the comment; resubmitting clears it.
        ...(input.to === "draft"
          ? { rejectionComment: input.comment ?? null }
          : {}),
        ...(response.status === "draft" && input.to === "pending_approval"
          ? { rejectionComment: null }
          : {}),
        // A manual retry clears the previous failure before re-queueing.
        ...(response.status === "failed" && input.to === "approved"
          ? { errorDetail: null, moderationState: null, policyViolation: null }
          : {}),
        ...("errorDetail" in patch ? { errorDetail: patch.errorDetail } : {}),
        ...("moderationState" in patch
          ? { moderationState: patch.moderationState }
          : {}),
        ...("policyViolation" in patch
          ? { policyViolation: patch.policyViolation }
          : {}),
        ...("publishedAt" in patch ? { publishedAt: patch.publishedAt } : {}),
        ...("publishUpdateTime" in patch
          ? { publishUpdateTime: patch.publishUpdateTime }
          : {}),
      })
      // The concurrency guard (issue #80 implementation notes): the row must
      // still be in the status we loaded — 0 rows means a lost race.
      .where(
        and(
          eq(responses.id, response.id),
          eq(responses.status, response.status),
        ),
      )
      .returning();
    if (!updated) {
      return {
        ok: false as const,
        code: "conflict" as const,
        message: "Someone else acted on this response — reload and try again.",
      };
    }

    if (input.markSignalDeletedAtSource) {
      await tx
        .update(signals)
        .set({ availability: "deleted_at_source", updatedAt: new Date() })
        .where(
          and(
            eq(signals.id, response.signalId),
            eq(signals.practiceId, input.practiceId),
          ),
        );
    }

    await audit(tx, {
      practiceId: input.practiceId,
      actor: input.actor,
      action: input.auditAction ?? decision.auditAction,
      entityType: "responses",
      entityId: response.id,
      payload: {
        from: response.status,
        to: input.to,
        signalId: response.signalId,
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
        ...(input.safety !== undefined
          ? {
              safetyLevel: input.safety.level,
              warningsAcknowledged: input.safety.warningsAcknowledged,
            }
          : {}),
        ...(input.markSignalDeletedAtSource
          ? { signalAvailability: "deleted_at_source" }
          : {}),
        ...input.auditPayload,
      },
    });

    return { ok: true as const, response: updated };
  });
}

// ---------------------------------------------------------------------------
// Surfacing helpers (badge + Today card, issue #82 requirement 4)
// ---------------------------------------------------------------------------

/** Approval-queue badge count for users who can approve (#80 req 7). */
export async function countPendingApprovals(
  db: Db,
  practiceId: string,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(responses)
    .where(
      and(
        eq(responses.practiceId, practiceId),
        eq(responses.status, "pending_approval"),
      ),
    );
  return row?.value ?? 0;
}

export interface FailedPublish {
  responseId: string;
  signalId: string;
  body: string;
  errorDetail: ResponseErrorDetail | null;
  failedAt: Date;
  sourceUrl: string | null;
}

/**
 * Failed publishes, newest failure first — the Today queue's card
 * condition (#82 requirement 4 / #95 section 5). Capped `{ items, total }`
 * per the Today section contract.
 */
export async function listFailedPublishes(
  db: Db,
  params: { practiceId: string; limit?: number },
): Promise<TodaySection<FailedPublish>> {
  const limit = params.limit ?? TODAY_SECTION_LIMIT;
  const conditions = and(
    eq(responses.practiceId, params.practiceId),
    eq(responses.status, "failed"),
  );
  const [items, counts] = await Promise.all([
    db
      .select({
        responseId: responses.id,
        signalId: responses.signalId,
        body: responses.body,
        errorDetail: responses.errorDetail,
        failedAt: responses.updatedAt,
        sourceUrl: signals.sourceUrl,
      })
      .from(responses)
      .innerJoin(signals, eq(signals.id, responses.signalId))
      .where(conditions)
      .orderBy(desc(responses.updatedAt), desc(responses.id))
      .limit(limit),
    db.select({ total: count() }).from(responses).where(conditions),
  ]);
  return { items, total: counts[0]?.total ?? 0 };
}

export interface PendingApprovalCard {
  responseId: string;
  signalId: string;
  body: string;
  authorName: string | null;
  /** When the response entered pending_approval (the transition write). */
  submittedAt: Date;
}

/**
 * Responses awaiting THIS viewer's approval, oldest first — the Today
 * queue's section 6 (#95). Excludes the viewer's own drafts: on
 * non-negative reviews they could self-approve directly, and on negative
 * ones the structural rule forbids it — either way the card would be
 * noise. (`IS DISTINCT FROM` keeps authorless #214 rows excluded-safe.)
 */
export async function listResponsesPendingApproval(
  db: Db,
  params: { practiceId: string; excludeAuthorId: string; limit?: number },
): Promise<TodaySection<PendingApprovalCard>> {
  const limit = params.limit ?? TODAY_SECTION_LIMIT;
  const conditions = and(
    eq(responses.practiceId, params.practiceId),
    eq(responses.status, "pending_approval"),
    sql`${responses.authorId} IS DISTINCT FROM ${params.excludeAuthorId}::uuid`,
  );
  const [items, counts] = await Promise.all([
    db
      .select({
        responseId: responses.id,
        signalId: responses.signalId,
        body: responses.body,
        authorName: staffMembers.displayName,
        submittedAt: responses.updatedAt,
      })
      .from(responses)
      .leftJoin(staffMembers, eq(staffMembers.id, responses.authorId))
      .where(conditions)
      .orderBy(asc(responses.updatedAt), asc(responses.id))
      .limit(limit),
    db.select({ total: count() }).from(responses).where(conditions),
  ]);
  return { items, total: counts[0]?.total ?? 0 };
}

/**
 * Standalone audit append for a publish attempt that will be RETRIED by the
 * queue (no state transition — the row stays `approved`): the capability
 * audits every call, and "an outcome that cannot be audited must not be
 * reported as clean" (issue #127), so retried attempts land in `audit_log`
 * too.
 */
export async function auditPublishAttempt(
  db: Db,
  input: {
    practiceId: string;
    responseId: string;
    actor: Actor;
    action: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await audit(db, {
    practiceId: input.practiceId,
    actor: input.actor,
    action: input.action,
    entityType: "responses",
    entityId: input.responseId,
    payload: input.payload,
  });
}
