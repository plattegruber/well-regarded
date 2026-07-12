/**
 * `publishReply` / `deleteReply` — the Google Business Profile review-reply
 * capability (issue #127, Epic #7).
 *
 * This module is the ADAPTER CAPABILITY only: a pair of plain async
 * functions that talk to Google's v4 reply endpoints with retry/backoff,
 * typed failure classification, and one audit event per call. The approval
 * workflow that decides WHEN to call them — and the `responses` table that
 * persists outcomes — arrives with Epic #10 (#80/#82); the contract those
 * consume is {@link PublishReplyResult} and {@link ReplyErrorDetail}.
 *
 * MODERATION (the #117 spike's correction to this issue)
 * ------------------------------------------------------
 * Since 2026-04-01 owner replies are moderated: the reply PUT returns
 * `reviewReplyState` (`PENDING` / `APPROVED` / `REJECTED`), and since
 * 2026-07-01 a rejected reply carries `policyViolation` (the reason). A 200
 * therefore does NOT mean the reply is live:
 *
 * - `PENDING` / `APPROVED` → `{ published: true, state }` — "accepted by
 *   Google". `PENDING` is the normal fresh-reply outcome; treat `published`
 *   as accepted-not-final.
 * - `REJECTED` → `{ published: false, state: 'REJECTED', policyViolation }`
 *   — a moderation OUTCOME, not an error: nothing to retry, the text needs
 *   a human.
 * - The asynchronous PENDING → APPROVED/REJECTED flip is detected by the
 *   poller (#123): moderation bumps the review's `updateTime`, and the
 *   adapter (#125) passes `reviewReply.reviewReplyState`/`policyViolation`
 *   through as `sourceMetadata.existingReply`. No polling machinery here.
 *
 * FAILURE CLASSIFICATION (the Epic #10 `error_detail` contract)
 * -------------------------------------------------------------
 * Callers persist failures from the thrown error via
 * {@link replyErrorDetail}, which renders the issue-#127 contract shape:
 *
 * - `{ kind: 'transient_exhausted', lastStatus?, message, at }` —
 *   {@link TransientReplyError}: 429/5xx/401/network errors, retried with
 *   exponential backoff + jitter (3 attempts, bounded well under 60s of
 *   wall time) and still failing. Retriable by the caller later.
 * - `{ kind: 'permanent', reason, status?, googleStatus?, message, at }` —
 *   {@link PermanentReplyError}: never retried. `reason` values worth
 *   special-casing downstream:
 *   - `location_unverified` — Google's 400 `FAILED_PRECONDITION`: "This
 *     operation is only valid if the specified location is verified." A
 *     location that loses verification fails permanently until re-verified.
 *   - `review_not_found` — 404: the review is gone at the source. Callers
 *     should also flag the signal per the `signals.availability` convention
 *     (`deleted_at_source`) — that fact is independently valuable.
 *   - `reply_too_long` / `empty_reply` / `invalid_review_name` — rejected
 *     locally, before any HTTP call (the 4096-BYTE cap is validated on
 *     UTF-8 byte length: an emoji-heavy reply exceeds it below 4096 chars).
 * - `{ kind: 'needs_reauth', at }` — {@link NeedsReauthError} propagated
 *   from the token provider (#118), whose machinery owns the connection
 *   status flip. Never retried here.
 *
 * IDEMPOTENCY: Google's reply PUT is a documented upsert of the single
 * owner reply ("A reply is created if one does not exist"), so a repeated
 * `publishReply` after a crash is content-safe. The already-`published`
 * short-circuit lives with the `responses` row (Epic #10) — this function
 * has no persistence to consult.
 *
 * Every call emits exactly one {@link ReplyAuditEvent} through
 * `deps.audit`; the caller maps it to an `audit_log` row (adding the
 * `practiceId` it resolved the connection under) in the same transaction
 * as its own state change. NEVER-LOG(credentials): access tokens flow
 * through here and must not appear in errors, audit detail, or logs.
 */

import type { Actor } from "@wellregarded/core";
import { GBP_REVIEW_NAME_PATTERN } from "./schema.js";

/** Real host for the v4 reply endpoints; tests point `baseUrl` at the fake. */
export const GBP_API_BASE_URL = "https://mybusiness.googleapis.com";

/** Google's reply cap — BYTES of UTF-8, not characters (ADR 0002). */
export const GBP_REPLY_MAX_BYTES = 4096;

/** Attempts per call (initial + retries) for transient failures. */
export const GBP_REPLY_MAX_ATTEMPTS = 3;

/**
 * Base backoff before attempt 2 and 3 (jittered to 50–150%; a 429's
 * `Retry-After` header, capped at {@link GBP_REPLY_MAX_DELAY_MS}, takes
 * precedence). Worst case ≈ 15s of waiting — bounded far under the <60s
 * budget issue #127 sets for Workflow-step callers.
 */
export const GBP_REPLY_BACKOFF_MS = [2_000, 8_000] as const;

/** Ceiling for any single backoff wait (also caps honored `Retry-After`). */
export const GBP_REPLY_MAX_DELAY_MS = 30_000;

/** v4 `reviewReplyState` vocabulary (moderation, 2026-04-01). */
export const GBP_REPLY_STATES = ["PENDING", "REJECTED", "APPROVED"] as const;
export type GbpReplyState = (typeof GBP_REPLY_STATES)[number];

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Why a {@link PermanentReplyError} is permanent. */
export type PermanentReplyReason =
  /** Rejected locally: the reply exceeds {@link GBP_REPLY_MAX_BYTES} UTF-8 bytes. */
  | "reply_too_long"
  /** Rejected locally: empty reply text. */
  | "empty_reply"
  /** Rejected locally: `reviewSourceId` is not a v4 review resource name. */
  | "invalid_review_name"
  /** Google 400 `INVALID_ARGUMENT` — content Google refuses. */
  | "invalid_argument"
  /** Google 400 `FAILED_PRECONDITION` — the location is not verified. */
  | "location_unverified"
  /** Google 403 — the connected account lost access to the location. */
  | "permission_denied"
  /** Google 404 on the reply PUT — the review is gone at the source. */
  | "review_not_found"
  /** Google 404 on the reply DELETE — no owner reply exists. */
  | "reply_not_found"
  /** Any other non-retryable response — do not retry what we don't know. */
  | "unexpected";

/** Google's v4 JSON error envelope, as much of it as we could read. */
export interface GoogleErrorInfo {
  /** HTTP status. Absent when the failure never reached Google. */
  status?: number;
  /** `error.status`, e.g. `INVALID_ARGUMENT`, `FAILED_PRECONDITION`. */
  googleStatus?: string;
  /** `error.message` — Google's human-readable reason. */
  googleMessage?: string;
}

/**
 * A failure that retrying cannot fix. Never retried; callers persist it via
 * {@link replyErrorDetail} and surface it ("Publishing failed — Google
 * says…").
 */
export class PermanentReplyError extends Error {
  readonly retryable = false as const;
  readonly reason: PermanentReplyReason;
  readonly google: GoogleErrorInfo;

  constructor(
    reason: PermanentReplyReason,
    message: string,
    google: GoogleErrorInfo = {},
  ) {
    super(message);
    this.name = "PermanentReplyError";
    this.reason = reason;
    this.google = google;
  }
}

/**
 * Transient failures (429/5xx/401/network) that survived every in-call
 * retry. The caller may re-invoke later — the reply PUT is an upsert, so a
 * retry after partial success is content-safe.
 */
export class TransientReplyError extends Error {
  readonly retryable = true as const;
  readonly attempts: number;
  /** HTTP status of the last attempt; absent when it was a network error. */
  readonly lastStatus: number | undefined;

  constructor(message: string, attempts: number, lastStatus?: number) {
    super(message);
    this.name = "TransientReplyError";
    this.attempts = attempts;
    this.lastStatus = lastStatus;
  }
}

/**
 * The `error_detail` contract Epic #10's `responses` rows persist and its
 * inbox renders (issue #127 requirement 5). Produced from thrown errors by
 * {@link replyErrorDetail}.
 */
export type ReplyErrorDetail =
  | {
      kind: "transient_exhausted";
      lastStatus?: number;
      message: string;
      at: string;
    }
  | {
      kind: "permanent";
      reason: PermanentReplyReason;
      status?: number;
      googleStatus?: string;
      message: string;
      at: string;
    }
  | { kind: "needs_reauth"; at: string };

/**
 * Render a thrown publish/delete error as the persistable
 * {@link ReplyErrorDetail}. Returns undefined for errors this module did
 * not produce (a bug, not an outcome — let those crash the caller).
 */
export function replyErrorDetail(
  error: unknown,
  at: string,
): ReplyErrorDetail | undefined {
  if (error instanceof PermanentReplyError) {
    return {
      kind: "permanent",
      reason: error.reason,
      ...(error.google.status !== undefined
        ? { status: error.google.status }
        : {}),
      ...(error.google.googleStatus !== undefined
        ? { googleStatus: error.google.googleStatus }
        : {}),
      message: error.message,
      at,
    };
  }
  if (error instanceof TransientReplyError) {
    return {
      kind: "transient_exhausted",
      ...(error.lastStatus !== undefined
        ? { lastStatus: error.lastStatus }
        : {}),
      message: error.message,
      at,
    };
  }
  if (error instanceof Error && error.name === "NeedsReauthError") {
    return { kind: "needs_reauth", at };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Deps, inputs, results
// ---------------------------------------------------------------------------

/** One audit event per publish/delete call (issue #127 requirement 7). */
export interface ReplyAuditEvent {
  /**
   * Dot-namespaced `entity.verb` per the `audit_log` convention:
   * `response.published`, `response.publish_rejected` (moderation),
   * `response.publish_failed`, `response.reply_deleted`,
   * `response.reply_delete_failed`.
   */
  action:
    | "response.published"
    | "response.publish_rejected"
    | "response.publish_failed"
    | "response.reply_deleted"
    | "response.reply_delete_failed";
  /** Who initiated: the approving `staff` member, or a `system` job. */
  actor: Actor;
  connectionId: string;
  /** The review's full v4 resource name (= `signals.source_id`). */
  reviewSourceId: string;
  /**
   * Non-PII outcome context: `{ state, policyViolation?, updateTime,
   * attempts }` on success/rejection, `{ error: ReplyErrorDetail,
   * attempts }` on failure. Reply TEXT is deliberately absent.
   */
  detail: Record<string, unknown>;
  /** ISO timestamp from `deps.now`. */
  at: string;
}

export interface GbpReplyDeps {
  /**
   * Access token for the connection — wire to #118's
   * `AccessTokenProvider.getAccessToken` with the decrypted connection row.
   * Must throw `NeedsReauthError` on `invalid_grant` (propagated untouched;
   * #118's `onInvalidGrant` machinery owns the connection-status flip) and
   * `GoogleOAuthError` on other token-endpoint failures (treated as
   * transient and retried here).
   */
  getAccessToken: (connectionId: string) => Promise<string>;
  /**
   * Audit sink — called EXACTLY ONCE per publish/delete call with the
   * outcome. The caller maps the event to an `audit_log` row (it knows the
   * `practiceId` it resolved the connection under) inside the same
   * transaction as its own state change. A throw here propagates: an
   * outcome that cannot be audited must not be reported as clean.
   */
  audit: (event: ReplyAuditEvent) => Promise<void>;
  /** Injectable for tests (`fakeGbp.app.fetch`-backed). Default: global fetch. */
  fetch?: typeof fetch;
  /** v4 API origin. Default {@link GBP_API_BASE_URL}. */
  baseUrl?: string;
  /** Injectable backoff sleep (tests: record-and-return). Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1). Default: Math.random. */
  random?: () => number;
  /** Clock for audit/`error_detail` timestamps. Default: () => new Date(). */
  now?: () => Date;
  /**
   * Called once before retrying a 401 — wire to the token provider's
   * `invalidate(connectionId)` so the retry refreshes instead of replaying
   * the same stale cached token.
   */
  invalidateAccessToken?: (connectionId: string) => void;
}

export interface PublishReplyInput {
  /** `source_connections.id` — the practice's Google connection. */
  connectionId: string;
  /**
   * The review's full v4 resource name
   * (`accounts/{a}/locations/{l}/reviews/{r}`) — `signals.source_id` for
   * `sourceKind: 'google'` signals, verbatim.
   */
  reviewSourceId: string;
  /** The reply text. Max {@link GBP_REPLY_MAX_BYTES} UTF-8 bytes. */
  text: string;
  /** Recorded on the audit event: the approving staff member or a system job. */
  actor: Actor;
}

export interface PublishReplyResult {
  /**
   * Google accepted the reply and has not rejected it. `true` means
   * "accepted", not "live": a fresh reply is `PENDING` until moderation
   * approves it, and a later rejection arrives asynchronously via the
   * poller (#123) → adapter (#125) `sourceMetadata.existingReply` path.
   */
  published: boolean;
  /**
   * Moderation state from the PUT response. Absent when Google omitted it
   * (or returned vocabulary we don't know — never guessed).
   */
  state?: GbpReplyState;
  /** Rejection reason — only when `state` is `REJECTED` (Google, 2026-07-01). */
  policyViolation?: string;
  /** The reply's `updateTime` as Google recorded it. */
  updateTime?: string;
  /** HTTP attempts made (1 = no retries needed). */
  attempts: number;
}

export interface DeleteReplyInput {
  connectionId: string;
  /** The review's full v4 resource name (see {@link PublishReplyInput}). */
  reviewSourceId: string;
  actor: Actor;
}

export interface DeleteReplyResult {
  deleted: true;
  attempts: number;
}

// ---------------------------------------------------------------------------
// publishReply / deleteReply
// ---------------------------------------------------------------------------

/**
 * Upsert the owner reply on a Google review. See the module doc for the
 * moderation semantics, retry policy, and the `error_detail` contract; the
 * behavior matrix in one line each:
 *
 * - 200 → `{ published, state, policyViolation?, updateTime, attempts }`
 * - 429/5xx/401/network → retried (backoff + jitter), then
 *   {@link TransientReplyError}
 * - 400/403/404 (and locally-rejected input) → {@link PermanentReplyError},
 *   never retried; `reason: 'review_not_found'` should also flip the
 *   signal's `availability` to `deleted_at_source` in the caller
 * - dead refresh grant → `NeedsReauthError` (from `deps.getAccessToken`),
 *   never retried
 */
export async function publishReply(
  deps: GbpReplyDeps,
  input: PublishReplyInput,
): Promise<PublishReplyResult> {
  const audited = auditedCall(deps, input, {
    success: "response.published",
    failure: "response.publish_failed",
  });
  return audited(async (attempted) => {
    validateReviewName(input.reviewSourceId);
    validateReplyText(input.text);

    const response = await requestWithRetries(
      deps,
      input.connectionId,
      attempted,
      {
        method: "PUT",
        url: replyUrl(deps, input.reviewSourceId),
        body: JSON.stringify({ comment: input.text }),
      },
    );

    const reply = await parseReplyBody(response);
    const state = reply.state;
    const result: PublishReplyResult = {
      published: state !== "REJECTED",
      attempts: attempted.count,
      ...(state !== undefined ? { state } : {}),
      ...(reply.policyViolation !== undefined
        ? { policyViolation: reply.policyViolation }
        : {}),
      ...(reply.updateTime !== undefined
        ? { updateTime: reply.updateTime }
        : {}),
    };
    return {
      result,
      // A moderation rejection is an outcome, not an error — but it is a
      // DIFFERENT outcome, and the audit trail must say so.
      ...(result.published
        ? {}
        : { action: "response.publish_rejected" as const }),
      detail: {
        ...(state !== undefined ? { state } : {}),
        ...(reply.policyViolation !== undefined
          ? { policyViolation: reply.policyViolation }
          : {}),
        ...(reply.updateTime !== undefined
          ? { updateTime: reply.updateTime }
          : {}),
      },
    };
  });
}

/**
 * Delete the owner reply on a Google review. Same retry/error contract as
 * {@link publishReply}; a 404 (no reply, or review gone) is
 * {@link PermanentReplyError} `reason: 'reply_not_found'`.
 */
export async function deleteReply(
  deps: GbpReplyDeps,
  input: DeleteReplyInput,
): Promise<DeleteReplyResult> {
  const audited = auditedCall(deps, input, {
    success: "response.reply_deleted",
    failure: "response.reply_delete_failed",
  });
  return audited(async (attempted) => {
    validateReviewName(input.reviewSourceId);
    const response = await requestWithRetries(
      deps,
      input.connectionId,
      attempted,
      {
        method: "DELETE",
        url: replyUrl(deps, input.reviewSourceId),
        notFoundReason: "reply_not_found",
      },
    );
    await response.body?.cancel();
    return {
      result: { deleted: true as const, attempts: attempted.count },
      detail: {},
    };
  });
}

// ---------------------------------------------------------------------------
// Local validation (issue #127: don't let Google's opaque 400 be the UX)
// ---------------------------------------------------------------------------

/** UTF-8 byte length of a reply — the unit Google's 4096 cap counts. */
export function replyByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function validateReviewName(reviewSourceId: string): void {
  if (!GBP_REVIEW_NAME_PATTERN.test(reviewSourceId)) {
    throw new PermanentReplyError(
      "invalid_review_name",
      `Not a v4 review resource name (accounts/*/locations/*/reviews/*): ${reviewSourceId}`,
    );
  }
}

function validateReplyText(text: string): void {
  if (text.length === 0) {
    throw new PermanentReplyError(
      "empty_reply",
      "Reply text must not be empty.",
    );
  }
  const bytes = replyByteLength(text);
  if (bytes > GBP_REPLY_MAX_BYTES) {
    throw new PermanentReplyError(
      "reply_too_long",
      `Reply is ${bytes} UTF-8 bytes; Google allows at most ${GBP_REPLY_MAX_BYTES} ` +
        `(bytes, not characters — emoji count 4 each).`,
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP with classification and bounded retries
// ---------------------------------------------------------------------------

interface AttemptCounter {
  count: number;
}

interface ReplyRequest {
  method: "PUT" | "DELETE";
  url: string;
  body?: string;
  /** How to classify a 404 (PUT: review gone; DELETE: reply gone). */
  notFoundReason?: PermanentReplyReason;
}

function replyUrl(deps: GbpReplyDeps, reviewSourceId: string): string {
  return `${deps.baseUrl ?? GBP_API_BASE_URL}/v4/${reviewSourceId}/reply`;
}

async function requestWithRetries(
  deps: GbpReplyDeps,
  connectionId: string,
  attempted: AttemptCounter,
  request: ReplyRequest,
): Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;

  let lastStatus: number | undefined;
  let lastMessage = "";

  for (let attempt = 1; attempt <= GBP_REPLY_MAX_ATTEMPTS; attempt++) {
    attempted.count = attempt;

    // Token first, inside the loop: cached while fresh (#118 provider), and
    // a transient token-endpoint failure (GoogleOAuthError) participates in
    // the same retry budget. NeedsReauthError propagates immediately.
    let response: Response;
    try {
      const accessToken = await deps.getAccessToken(connectionId);
      response = await doFetch(request.url, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(request.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        ...(request.body !== undefined ? { body: request.body } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "NeedsReauthError")
        throw error;
      // Network error or transient token-endpoint failure.
      lastStatus = undefined;
      lastMessage = error instanceof Error ? error.message : String(error);
      if (attempt < GBP_REPLY_MAX_ATTEMPTS) {
        await sleep(backoffDelayMs(attempt, undefined, random));
        continue;
      }
      break;
    }

    if (response.ok) return response;

    const google = await readGoogleError(response);
    lastStatus = response.status;
    lastMessage = google.googleMessage ?? `HTTP ${response.status}`;

    if (!isTransientStatus(response.status)) {
      throw classifyPermanent(response.status, google, request.notFoundReason);
    }

    if (attempt < GBP_REPLY_MAX_ATTEMPTS) {
      // A stale cached bearer 401s: drop it so the retry mints a fresh one.
      if (response.status === 401) deps.invalidateAccessToken?.(connectionId);
      await sleep(backoffDelayMs(attempt, retryAfterMs(response), random));
    }
  }

  throw new TransientReplyError(
    `Google reply ${request.method} failed after ${attempted.count} attempts: ${lastMessage}`,
    attempted.count,
    lastStatus,
  );
}

/** 429, any 5xx, and 401 (stale cached token) are worth retrying. */
function isTransientStatus(status: number): boolean {
  return status === 429 || status === 401 || status >= 500;
}

function classifyPermanent(
  status: number,
  google: GoogleErrorInfo,
  notFoundReason: PermanentReplyReason = "review_not_found",
): PermanentReplyError {
  const message =
    google.googleMessage ?? `Google rejected the request (HTTP ${status}).`;
  // Distinct classification for the verification precondition (issue #127
  // requirement 3 addendum): a location that loses verification after
  // mapping fails permanently, and the message must say so.
  if (status === 400 && google.googleStatus === "FAILED_PRECONDITION") {
    return new PermanentReplyError(
      "location_unverified",
      `Google blocks replies on unverified locations: ${message}`,
      google,
    );
  }
  if (status === 400)
    return new PermanentReplyError("invalid_argument", message, google);
  if (status === 403)
    return new PermanentReplyError("permission_denied", message, google);
  if (status === 404)
    return new PermanentReplyError(notFoundReason, message, google);
  return new PermanentReplyError("unexpected", message, google);
}

/** Parse Google's JSON error envelope, tolerating non-JSON bodies. */
async function readGoogleError(response: Response): Promise<GoogleErrorInfo> {
  const info: GoogleErrorInfo = { status: response.status };
  const body: unknown = await response.json().catch(() => undefined);
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (error && typeof error === "object") {
      const { status, message } = error as {
        status?: unknown;
        message?: unknown;
      };
      if (typeof status === "string") info.googleStatus = status;
      if (typeof message === "string") info.googleMessage = message;
    }
  }
  return info;
}

/**
 * Backoff before retrying `attempt` (1-based): a 429's `Retry-After` when
 * present, else the exponential base jittered to 50–150% — both capped at
 * {@link GBP_REPLY_MAX_DELAY_MS}.
 */
function backoffDelayMs(
  attempt: number,
  retryAfter: number | undefined,
  random: () => number,
): number {
  if (retryAfter !== undefined)
    return Math.min(retryAfter, GBP_REPLY_MAX_DELAY_MS);
  const base =
    GBP_REPLY_BACKOFF_MS[attempt - 1] ?? GBP_REPLY_BACKOFF_MS.at(-1) ?? 8_000;
  return Math.min(Math.round(base * (0.5 + random())), GBP_REPLY_MAX_DELAY_MS);
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

// ---------------------------------------------------------------------------
// Success parsing & the one-audit-event-per-call wrapper
// ---------------------------------------------------------------------------

interface ParsedReply {
  state?: GbpReplyState;
  policyViolation?: string;
  updateTime?: string;
}

/**
 * Read the PUT's `ReviewReply` body defensively. A 200 means Google
 * accepted the write; an unreadable body (or unknown `reviewReplyState`
 * vocabulary) must not convert that success into a failure — fields we
 * cannot read are simply absent, and the poller reconciles ground truth on
 * its next sync.
 */
async function parseReplyBody(response: Response): Promise<ParsedReply> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!body || typeof body !== "object") return {};
  const { reviewReplyState, policyViolation, updateTime } = body as {
    reviewReplyState?: unknown;
    policyViolation?: unknown;
    updateTime?: unknown;
  };
  return {
    ...(typeof reviewReplyState === "string" &&
    (GBP_REPLY_STATES as readonly string[]).includes(reviewReplyState)
      ? { state: reviewReplyState as GbpReplyState }
      : {}),
    ...(typeof policyViolation === "string" ? { policyViolation } : {}),
    ...(typeof updateTime === "string" ? { updateTime } : {}),
  };
}

interface AuditedOutcome<T> {
  result: T;
  /** Override the success action (moderation rejection). */
  action?: ReplyAuditEvent["action"];
  detail: Record<string, unknown>;
}

/**
 * Wrap a publish/delete body so that EVERY exit — success, moderation
 * rejection, typed failure, `NeedsReauthError` — emits exactly one audit
 * event (issue #127 requirement 7).
 */
function auditedCall(
  deps: GbpReplyDeps,
  input: { connectionId: string; reviewSourceId: string; actor: Actor },
  actions: {
    success: ReplyAuditEvent["action"];
    failure: ReplyAuditEvent["action"];
  },
) {
  return async <T>(
    body: (attempted: AttemptCounter) => Promise<AuditedOutcome<T>>,
  ): Promise<T> => {
    const now = deps.now ?? (() => new Date());
    const attempted: AttemptCounter = { count: 0 };
    const base = {
      actor: input.actor,
      connectionId: input.connectionId,
      reviewSourceId: input.reviewSourceId,
    };
    try {
      const outcome = await body(attempted);
      await deps.audit({
        ...base,
        action: outcome.action ?? actions.success,
        detail: { ...outcome.detail, attempts: attempted.count },
        at: now().toISOString(),
      });
      return outcome.result;
    } catch (error) {
      const at = now().toISOString();
      const detail = replyErrorDetail(error, at);
      if (detail !== undefined) {
        await deps.audit({
          ...base,
          action: actions.failure,
          detail: { error: detail, attempts: attempted.count },
          at,
        });
      }
      throw error;
    }
  };
}
