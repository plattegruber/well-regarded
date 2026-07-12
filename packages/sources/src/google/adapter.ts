/**
 * `googleReviewsAdapter` — the Google Business Profile `SourceAdapter`
 * (issue #125, Epic #7).
 *
 * One stored artifact (a reviews-page envelope, shape in ./schema.ts) →
 * one `NormalizedSignal` per review. Pure by contract: no network, no DB —
 * everything normalization needs is in the envelope; if something seems
 * missing, the poller's envelope (#123) is where to add it.
 *
 * Google's quirks, mapped faithfully:
 *
 * - **Star-only reviews** (no `comment`): valid signals — `originalText`
 *   null, rating kept. Never dropped, never empty-stringed.
 * - **Edited reviews** (`updateTime` > `createTime`): `occurredAt` stays
 *   `createTime` — the patient experience happened then. The changed text
 *   is dedupe's job (#106, content hash → version row); `updateTime` rides
 *   `sourceMetadata.sourceUpdatedAt` so the version row can carry
 *   `source_updated_at`.
 * - **Pre-existing owner replies** (`reviewReply`): captured as
 *   `sourceMetadata.existingReply` (comment, updateTime, moderation state,
 *   rejection reason) so the review inbox (Epic #10) can render "already
 *   replied on Google" instead of prompting a fresh draft. No `responses`
 *   rows here — adapters normalize; they don't write workflow tables.
 * - **Anonymized reviewers** (`isAnonymous`): `authorDisplayName` null —
 *   Google's "A Google user" placeholder is not a name. No
 *   `authorExternalId` ever (Google gives no stable reviewer id we may
 *   keep) and no `patientHint` — consistent with `supportsIdentity: false`.
 * - **Translations**: `comment` passes through byte-for-byte, including
 *   Google's "(Translated by Google)" wrapper — no translation handling
 *   at M1.
 * - **Location**: the envelope's `googleLocationName` becomes a
 *   `locationHint` with basis `source_metadata`. The normalize stage
 *   resolves it to our `location_id` via the #121 mapping (the resource
 *   name is an exact-match key — the confident path by construction);
 *   the adapter never guesses FKs.
 *
 * A malformed artifact (schema drift from Google, unknown `starRating`
 * such as `STAR_RATING_UNSPECIFIED`, broken envelope) throws — the
 * normalize stage turns that into a non-retryable failure recorded on the
 * import run, which is the intended loud path.
 */

import type {
  EntityHint,
  NormalizedSignal,
  SignalSourceMetadata,
} from "../contract/normalizedSignal.js";
import type { SourceAdapter } from "../contract/sourceAdapter.js";
import {
  GBP_STAR_RATING_VALUES,
  type GbpReviewPayload,
  googleReviewsArtifactSchema,
} from "./schema.js";

function toSourceMetadata(review: GbpReviewPayload): SignalSourceMetadata {
  const metadata: SignalSourceMetadata = {
    // Always carried: Google reports updateTime on every review (equal to
    // createTime until an edit). Dedupe reads it only when recording an
    // edited version (#106).
    sourceUpdatedAt: review.updateTime,
  };
  const reply = review.reviewReply;
  if (reply !== undefined) {
    metadata.existingReply = {
      comment: reply.comment,
      ...(reply.updateTime !== undefined
        ? { updateTime: reply.updateTime }
        : {}),
      ...(reply.reviewReplyState !== undefined
        ? { state: reply.reviewReplyState }
        : {}),
      ...(reply.policyViolation !== undefined
        ? { policyViolation: reply.policyViolation }
        : {}),
    };
  }
  return metadata;
}

function toAuthorDisplayName(review: GbpReviewPayload): string | null {
  const reviewer = review.reviewer;
  if (reviewer === undefined || reviewer.isAnonymous === true) return null;
  const displayName = reviewer.displayName?.trim();
  return displayName !== undefined && displayName.length > 0
    ? displayName
    : null;
}

function toNormalizedSignal(
  review: GbpReviewPayload,
  locationHint: EntityHint,
): NormalizedSignal {
  return {
    // Public by definition: a Google review is visible at the source.
    visibility: "public",
    // The experience happened at createTime — even for edited reviews (see
    // module doc; updateTime rides sourceMetadata instead).
    occurredAt: review.createTime,
    // Empty-comment ratings are valid signals: null text, real rating.
    originalText: review.comment ?? null,
    rating: { value: GBP_STAR_RATING_VALUES[review.starRating], scale: 5 },
    authorDisplayName: toAuthorDisplayName(review),
    authorExternalId: null,
    sourceKind: "google",
    // The full resource name (accounts/*/locations/*/reviews/*) — stable
    // across edits, exactly what dedupe's exact path needs.
    sourceId: review.name,
    sourceUrl: null,
    locationHint,
    sourceMetadata: toSourceMetadata(review),
  };
}

export const googleReviewsAdapter: SourceAdapter = {
  sourceKind: "google",
  capabilities: {
    supportsIdentity: false,
    supportsConsent: false,
    supportsPolling: true,
  },
  // `async` despite no await: a bad artifact must REJECT (the contract
  // suite awaits), never throw synchronously out of the call expression.
  async normalize(rawArtifact: unknown): Promise<NormalizedSignal[]> {
    const artifact = googleReviewsArtifactSchema.parse(rawArtifact);
    const locationHint: EntityHint = {
      text: artifact.googleLocationName,
      basis: "source_metadata",
    };
    // A degenerate artifact (empty page) yields [] — proto3 omits the
    // `reviews` field entirely on an empty response.
    return (artifact.page.reviews ?? []).map((review) =>
      toNormalizedSignal(review, locationHint),
    );
  },
};
