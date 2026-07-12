/**
 * Public-review vocabulary (issues #76/#77, Epic #10).
 *
 * Reviews ARE signals — there is no reviews table. A signal reads as a
 * public review when `visibility = 'public'` AND its `source_kind` has
 * review semantics ({@link REVIEW_SOURCE_KINDS}). The review inbox query
 * (`listReviewInbox` in `@wellregarded/db`) selects on exactly that
 * predicate; this module is the single source of truth for the vocabulary
 * so the query, the URL-param parser, and the approval workflow (#80)
 * cannot drift.
 */

import type { Sentiment } from "./derivations.js";
import type { SourceKind } from "./signals.js";

/**
 * Source kinds with public-review semantics (issue #76): a Google review,
 * an imported review from a CSV export, or a review a staff member typed
 * in by hand. `email`/`firstparty`/`opendental` signals are feedback, not
 * reviews — even a public one would not belong in the response workspace.
 */
export const REVIEW_SOURCE_KINDS = [
  "google",
  "csv_import",
  "manual",
] as const satisfies readonly SourceKind[];

export type ReviewSourceKind = (typeof REVIEW_SOURCE_KINDS)[number];

/** Narrowing guard for the review-inbox source predicate. */
export function isReviewSourceKind(kind: SourceKind): kind is ReviewSourceKind {
  return (REVIEW_SOURCE_KINDS as readonly SourceKind[]).includes(kind);
}

/**
 * The inbox's response-status vocabulary (issue #76): where a review sits
 * in the respond → approve → publish loop. Derived from the latest
 * `responses` row per signal — never a column on `signals`.
 */
export const REVIEW_RESPONSE_STATUSES = [
  "needs_response",
  "drafted",
  "pending_approval",
  "responded",
] as const;

export type ReviewResponseStatus = (typeof REVIEW_RESPONSE_STATUSES)[number];

/**
 * THE response-status resolution (issues #76/#80): maps the latest
 * `responses.status` for a signal onto the inbox vocabulary.
 *
 * `latestResponseStatus` is the `status` of the newest `responses` row for
 * the signal, or `null` when no response row exists. The `responses` table
 * is #80's work (in flight); until it lands every signal resolves through
 * the documented fallback — **no response recorded → `needs_response`**.
 * The SQL mirror of this mapping lives in `reviewsInbox.ts`
 * (`@wellregarded/db`); change both together.
 *
 * State mapping, over #80's `responses.status` machine
 * (draft → pending_approval → approved → published, with failed):
 *
 * - `null`               → `needs_response` (no response recorded)
 * - `draft`              → `drafted`
 * - `pending_approval`   → `pending_approval`
 * - `approved` / `failed`→ `pending_approval` — approved-but-unpublished
 *   and publish-failed responses are still inside the human gate, not yet
 *   public; the inbox must not read them as "responded" (#76 defines
 *   `responded` strictly as published)
 * - `published`          → `responded`
 * - anything else        → `drafted` — a response exists but is not
 *   published; the conservative reading for a status this version does
 *   not know
 */
export function reviewStatusFromResponseState(
  latestResponseStatus: string | null | undefined,
): ReviewResponseStatus {
  switch (latestResponseStatus ?? null) {
    case null:
      return "needs_response";
    case "draft":
      return "drafted";
    case "pending_approval":
    case "approved":
    case "failed":
      return "pending_approval";
    case "published":
      return "responded";
    default:
      return "drafted";
  }
}

/**
 * Is this review negative, for ordering and gating purposes? Shared by the
 * inbox's tier-1 "unresponded negative first" ordering (#76) and the
 * approval workflow's "negative reviews always require non-author
 * approval" rule (#80) — one predicate, so they cannot drift.
 *
 * Negative = rating ≤ 2 (on the source's 1–5 scale) OR, when unrated or
 * higher-rated, a current sentiment derivation of `negative`. The SQL
 * mirror lives in `reviewsInbox.ts` (`@wellregarded/db`).
 */
export function isNegativeReview(input: {
  /** Effective rating (current version wins), or null when unrated. */
  rating: number | null;
  /** Current sentiment derivation value, or null when unclassified. */
  sentiment: Sentiment | null;
}): boolean {
  if (input.rating !== null && input.rating <= 2) return true;
  return input.sentiment === "negative";
}
