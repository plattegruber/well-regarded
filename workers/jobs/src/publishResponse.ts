/**
 * The publish-response queue consumer (issue #82, Epic #10): wire
 * `approved` responses to the Epic #7 GBP `publishReply` capability and
 * record the outcome on the `responses` row per the issue-#127 seam
 * contract.
 *
 * Lives in workers/jobs — NOT workers/pipeline — because this worker
 * already holds everything a GBP call needs (OAuth client secrets, the PII
 * keyring for credential decryption, the #118 token provider and its
 * `persistNeedsReauth` hook); the pipeline worker has none of it. The
 * queue itself (`wr-publish-response`, produced by the dashboard's approve
 * and retry actions) is what the issue asks for: redelivery with
 * exponential delay across minutes, beyond `publishReply`'s in-call
 * seconds-scale retries.
 *
 * Outcome mapping (the #127 contract, `packages/sources/src/google/replies.ts`):
 *
 * - success (`published: true`, state PENDING/APPROVED) → status
 *   `published` + `published_at` + `moderation_state` + Google's
 *   `updateTime`. "Published" means ACCEPTED, not live — a later
 *   asynchronous REJECTED arrives via the #123 poller.
 * - synchronous REJECTED (`published: false`) → a needs-human outcome, not
 *   a retryable failure: status `failed` with
 *   `error_detail.kind = 'moderation_rejected'` + the policyViolation.
 * - `TransientReplyError` → re-queue (delay grows per attempt) while the
 *   delivery budget lasts; on the final delivery, status `failed` with
 *   `transient_exhausted` — the manual Retry button is the recovery.
 * - `PermanentReplyError` → status `failed` immediately, never re-queued;
 *   `review_not_found` ALSO flips the signal's availability to
 *   `deleted_at_source` in the same transaction.
 * - `NeedsReauthError` → status `failed` with the `auth` class, no retries
 *   burned (#118's `onInvalidGrant` already flipped the connection).
 *
 * Auditing: the capability emits exactly one audit event per call; this
 * consumer BUFFERS it and maps it to the `audit_log` row — adding the
 * practice id — in the same transaction as the `responses` write (via
 * `transitionResponse`'s audit override, so the transition and the Google
 * outcome are ONE row). Attempts that will be re-queued still audit
 * (standalone row, no transition): an outcome that cannot be audited must
 * not be reported as clean.
 *
 * All status writes go through the #80 state machine (`transitionResponse`)
 * — there are no direct UPDATEs here.
 */

import type { Actor, Logger } from "@wellregarded/core";
import {
  PUBLISH_RESPONSE_MAX_DELIVERIES,
  type PublishResponseMessage,
  publishResponseRetryDelaySeconds,
  type ResponseErrorDetail,
} from "@wellregarded/core";
import type {
  ResponseReviewContext,
  ReviewResponse,
  TransitionResponseResult,
} from "@wellregarded/db";
import type {
  PublishReplyResult,
  ReplyAuditEvent,
} from "@wellregarded/sources";
import { replyErrorDetail } from "@wellregarded/sources";

/** The system audit actor for every write this consumer makes. */
export const PUBLISH_RESPONSE_ACTOR: Actor = {
  type: "system",
  id: "jobs:publish-response",
};

/** The connection fields the consumer needs (a `source_connections` row). */
export interface PublishConnectionRow {
  id: string;
  status: string;
  encryptedCredentials: string | null;
}

/** Finalizing transition: the terminal write for this delivery. */
export interface FinalizePublishInput {
  practiceId: string;
  responseId: string;
  to: "published" | "failed";
  patch: {
    errorDetail?: ResponseErrorDetail | null;
    moderationState?: "PENDING" | "APPROVED" | "REJECTED" | null;
    policyViolation?: string | null;
    publishedAt?: Date | null;
    publishUpdateTime?: string | null;
  };
  auditAction: string;
  auditPayload: Record<string, unknown>;
  markSignalDeletedAtSource?: boolean;
}

/**
 * Persistence seam — the real implementation
 * (`createPublishResponseStore` in ./publishResponseRuntime.ts) is a thin
 * adapter over the packages/db helpers; tests inject an in-memory fake.
 */
export interface PublishResponseStore {
  getResponse(
    practiceId: string,
    responseId: string,
  ): Promise<ReviewResponse | undefined>;
  getReviewContext(
    practiceId: string,
    signalId: string,
  ): Promise<ResponseReviewContext | undefined>;
  /** The practice's Google connection (any status; the consumer decides). */
  getGoogleConnection(practiceId: string): Promise<PublishConnectionRow | null>;
  /** `transitionResponse` with the capability's audit event mapped in. */
  finalize(input: FinalizePublishInput): Promise<TransitionResponseResult>;
  /** Standalone audit row for an attempt that will be re-queued. */
  auditAttempt(input: {
    practiceId: string;
    responseId: string;
    action: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

export interface PublishResponseDeps {
  store: PublishResponseStore;
  /**
   * The Epic #7 capability behind its interface (so the fake GBP server
   * swap works): the runtime wires `publishReply` with the #118 token
   * provider; tests wire the same `publishReply` at the fake server.
   * MUST call `audit` exactly once per call (the capability guarantees it).
   */
  publish(input: {
    connection: PublishConnectionRow;
    reviewSourceId: string;
    text: string;
    actor: Actor;
    audit: (event: ReplyAuditEvent) => Promise<void>;
  }): Promise<PublishReplyResult>;
  log: Logger;
  now?: () => Date;
}

/** What the dispatcher should do with the message. */
export type PublishOutcome =
  | { kind: "ack"; result: string }
  | { kind: "retry"; delaySeconds: number };

/**
 * Consume one publish message. `attempt` is the queue's 1-based delivery
 * count (`message.attempts`); at `PUBLISH_RESPONSE_MAX_DELIVERIES` the
 * delivery is final and transient failures become `failed` rows instead of
 * retries. Never throws for workflow outcomes — unknown errors propagate
 * (the dispatcher retries those).
 */
export async function handlePublishResponseMessage(
  deps: PublishResponseDeps,
  message: PublishResponseMessage,
  attempt: number,
): Promise<PublishOutcome> {
  const { store, log } = deps;
  const now = deps.now ?? (() => new Date());
  const { practiceId, responseId } = message;

  const response = await store.getResponse(practiceId, responseId);
  if (!response) {
    log.warn("publish_response.missing_row", { responseId });
    return { kind: "ack", result: "missing" };
  }

  // Idempotency guard (issue #82 req 2 / #127 req 6): redelivery after a
  // crash-past-success must not double-send. Double-send is content-safe
  // regardless (the reply PUT is a single-reply upsert) — skip-and-log.
  if (response.status === "published") {
    log.info("publish_response.already_published", { responseId });
    return { kind: "ack", result: "already_published" };
  }
  if (response.status !== "approved") {
    // Stale message: the response was rejected/edited since enqueue.
    log.info("publish_response.not_approved", {
      responseId,
      status: response.status,
    });
    return { kind: "ack", result: "not_approved" };
  }

  const review = await store.getReviewContext(practiceId, response.signalId);
  const at = now().toISOString();

  if (!review || review.sourceKind !== "google" || review.sourceId === null) {
    return finalizeFailure(deps, message, {
      errorDetail: {
        kind: "permanent",
        reason: "unsupported_source",
        message: "Only Google reviews can be published to at the moment.",
        at,
      },
      auditAction: "response.publish_failed",
    });
  }

  // The review is known-deleted at the source: GBP would 404 — don't spend
  // a call or any retries (issue #82 implementation notes).
  if (review.availability === "deleted_at_source") {
    return finalizeFailure(deps, message, {
      errorDetail: {
        kind: "permanent",
        reason: "review_not_found",
        message: "This review no longer exists on Google.",
        at,
      },
      auditAction: "response.publish_failed",
    });
  }

  const connection = await store.getGoogleConnection(practiceId);
  if (
    !connection ||
    connection.status !== "active" ||
    connection.encryptedCredentials === null
  ) {
    // Auth-class failure (issue #82 req 6): it will fail until the
    // connection is re-authed — don't burn retries.
    return finalizeFailure(deps, message, {
      errorDetail: { kind: "needs_reauth", at },
      auditAction: "response.publish_failed",
    });
  }

  // Buffer the capability's one-per-call audit event; it is persisted in
  // the same transaction as the responses write below (the #127 contract).
  let auditEvent: ReplyAuditEvent | undefined;
  let result: PublishReplyResult;
  try {
    result = await deps.publish({
      connection,
      reviewSourceId: review.sourceId,
      text: response.body,
      actor: PUBLISH_RESPONSE_ACTOR,
      audit: async (event) => {
        auditEvent = event;
      },
    });
  } catch (error) {
    return handlePublishError(deps, message, error, auditEvent, attempt, now);
  }

  const eventDetail = auditEvent?.detail ?? {};

  if (!result.published) {
    // Synchronous moderation REJECTED: an outcome, not an error — nothing
    // to retry, the text needs a human (#117 spike).
    return applyFinalize(deps, message, {
      practiceId,
      responseId,
      to: "failed",
      patch: {
        errorDetail: {
          kind: "moderation_rejected",
          ...(result.policyViolation !== undefined
            ? { policyViolation: result.policyViolation }
            : {}),
          message: "Google rejected the reply under its content policy.",
          at: now().toISOString(),
        },
        moderationState: "REJECTED",
        policyViolation: result.policyViolation ?? null,
      },
      auditAction: auditEvent?.action ?? "response.publish_rejected",
      auditPayload: eventDetail,
    });
  }

  return applyFinalize(deps, message, {
    practiceId,
    responseId,
    to: "published",
    patch: {
      publishedAt: now(),
      publishUpdateTime: result.updateTime ?? null,
      moderationState: result.state ?? null,
      policyViolation: null,
      errorDetail: null,
    },
    auditAction: auditEvent?.action ?? "response.published",
    auditPayload: eventDetail,
  });
}

/** Classify a thrown publish error into finalize / retry. */
async function handlePublishError(
  deps: PublishResponseDeps,
  message: PublishResponseMessage,
  error: unknown,
  auditEvent: ReplyAuditEvent | undefined,
  attempt: number,
  now: () => Date,
): Promise<PublishOutcome> {
  const at = now().toISOString();
  const detail = replyErrorDetail(error, at);
  if (detail === undefined) {
    // Not an outcome this layer knows — a bug. Let the dispatcher retry
    // (and eventually dead-letter); no row write on speculation.
    throw error;
  }

  if (detail.kind === "transient_exhausted") {
    if (attempt < PUBLISH_RESPONSE_MAX_DELIVERIES) {
      // Still in budget: audit the failed attempt (the capability's event,
      // mapped by this caller), keep the row `approved`, and re-queue.
      await deps.store.auditAttempt({
        practiceId: message.practiceId,
        responseId: message.responseId,
        action: auditEvent?.action ?? "response.publish_failed",
        payload: {
          ...(auditEvent?.detail ?? { error: detail }),
          deliveryAttempt: attempt,
          willRetry: true,
        },
      });
      const delaySeconds = publishResponseRetryDelaySeconds(attempt);
      deps.log.warn("publish_response.retrying", {
        responseId: message.responseId,
        attempt,
        delaySeconds,
      });
      return { kind: "retry", delaySeconds };
    }
    return finalizeFailure(deps, message, {
      errorDetail: detail,
      auditAction: auditEvent?.action ?? "response.publish_failed",
      auditPayload: auditEvent?.detail,
    });
  }

  // needs_reauth (dead grant — #118's machinery already flipped the
  // connection) and permanent errors: never re-queued.
  return finalizeFailure(deps, message, {
    errorDetail: detail,
    auditAction: auditEvent?.action ?? "response.publish_failed",
    auditPayload: auditEvent?.detail,
    // The #127 contract: a publish 404 means the review is gone at the
    // source — flag the signal too, in the same transaction.
    markSignalDeletedAtSource:
      detail.kind === "permanent" && detail.reason === "review_not_found",
  });
}

async function finalizeFailure(
  deps: PublishResponseDeps,
  message: PublishResponseMessage,
  input: {
    errorDetail: ResponseErrorDetail;
    auditAction: string;
    auditPayload?: Record<string, unknown> | undefined;
    markSignalDeletedAtSource?: boolean;
  },
): Promise<PublishOutcome> {
  return applyFinalize(deps, message, {
    practiceId: message.practiceId,
    responseId: message.responseId,
    to: "failed",
    patch: { errorDetail: input.errorDetail },
    auditAction: input.auditAction,
    auditPayload: input.auditPayload ?? { error: input.errorDetail },
    ...(input.markSignalDeletedAtSource
      ? { markSignalDeletedAtSource: true }
      : {}),
  });
}

async function applyFinalize(
  deps: PublishResponseDeps,
  message: PublishResponseMessage,
  input: FinalizePublishInput,
): Promise<PublishOutcome> {
  const result = await deps.store.finalize(input);
  if (!result.ok) {
    // A lost race (someone acted on the row mid-flight): the other write
    // wins the state machine, but the Google outcome still happened — audit
    // it standalone so the trail stays complete, then move on.
    await deps.store.auditAttempt({
      practiceId: input.practiceId,
      responseId: input.responseId,
      action: input.auditAction,
      payload: { ...input.auditPayload, finalizeConflict: result.code },
    });
    deps.log.warn("publish_response.finalize_conflict", {
      responseId: message.responseId,
      to: input.to,
      code: result.code,
    });
    return { kind: "ack", result: `finalize_${result.code}` };
  }
  deps.log.info("publish_response.finalized", {
    responseId: message.responseId,
    to: input.to,
  });
  return { kind: "ack", result: input.to };
}
