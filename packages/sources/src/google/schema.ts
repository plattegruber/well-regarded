/**
 * Zod schemas for the Google reviews artifact (issue #125, Epic #7): the
 * v4 `reviews.list` payload plus the artifact envelope the poller (#123)
 * stores around it.
 *
 * Defensive-parsing posture (issue #125 implementation notes + ADR 0002
 * #125 adjustment):
 *
 * - **Tolerate unknown fields.** Google added `reviewReplyState`,
 *   `policyViolation`, and `reviewMediaItems` to the v4 review in 2026
 *   alone — a strict schema would have broken three times in one year.
 *   Objects here are `z.looseObject`: new fields pass through unharmed.
 * - **Reject unknown vocabulary.** The `starRating` lookup is TOTAL over
 *   `ONE`..`FIVE`; anything else — including Google's documented
 *   `STAR_RATING_UNSPECIFIED` — fails the artifact loudly (non-retryable,
 *   visible in the import run) rather than producing a garbage rating.
 * - Field shapes mirror the fake server's wire types
 *   (`src/google/fake/types.ts`, the #130 fidelity bar); the recorded
 *   fixtures in `src/google/fixtures/` pin the two against each other in
 *   `schema.test.ts`.
 *
 * THE ARTIFACT ENVELOPE (contract with the poller, #123)
 * ------------------------------------------------------
 * `normalize` receives one stored artifact = exactly one fetched reviews
 * page for one location, wrapped in {@link googleReviewsArtifactSchema}.
 * The adapter is pure (no network, no DB), so everything normalization
 * needs must be in the envelope:
 *
 * ```jsonc
 * {
 *   "kind": "gbp.reviews.page",              // discriminator, always this
 *   "envelopeVersion": 1,                    // bump on breaking change
 *   "practiceId": "<uuid>",                  // tenant provenance
 *   "googleLocationName": "accounts/1/locations/2", // v4 account-scoped
 *   //   resource name — the #121 mapping key; becomes the signal's
 *   //   locationHint, resolved to our location_id by the normalize stage
 *   "fetchedAt": "2026-07-01T00:00:00Z",     // when the poller fetched it
 *   "page": { ... }                          // the reviews.list response
 * }                                          //   body, VERBATIM
 * ```
 *
 * `page` must be the exact JSON Google returned — never re-shaped, never
 * filtered — so raw artifacts stay reproducible provenance (#100) and
 * dedupe's re-normalization (#106) sees the same bytes.
 */

import { z } from "zod";

/**
 * v4 `starRating` → numeric value, TOTAL over the ratable values. Google's
 * enum also documents `STAR_RATING_UNSPECIFIED`; it is deliberately absent
 * here — an unspecified rating on a review is shape drift and must reject
 * the artifact (see module doc).
 */
export const GBP_STAR_RATING_VALUES = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
} as const;

export type GbpRatableStarRating = keyof typeof GBP_STAR_RATING_VALUES;

const starRatingSchema = z.enum(
  Object.keys(GBP_STAR_RATING_VALUES) as [
    GbpRatableStarRating,
    ...GbpRatableStarRating[],
  ],
);

/** v4 review resource name: `accounts/{a}/locations/{l}/reviews/{r}`. */
export const GBP_REVIEW_NAME_PATTERN =
  /^accounts\/[^/]+\/locations\/[^/]+\/reviews\/[^/]+$/;

/** v4 location parent for the reviews path: `accounts/{a}/locations/{l}`. */
export const GBP_LOCATION_NAME_PATTERN = /^accounts\/[^/]+\/locations\/[^/]+$/;

const gbpReviewerSchema = z.looseObject({
  displayName: z.string().optional(),
  isAnonymous: z.boolean().optional(),
});

const gbpReviewReplySchema = z.looseObject({
  comment: z.string(),
  updateTime: z.iso.datetime({ offset: true }).optional(),
  /**
   * Moderation verdict (Google, 2026-04). Closed vocabulary on purpose: a
   * value we do not know would silently misrepresent whether the practice
   * has a live reply — fail the artifact loudly instead.
   */
  reviewReplyState: z.enum(["PENDING", "REJECTED", "APPROVED"]).optional(),
  /** Rejection reason (Google, 2026-07). */
  policyViolation: z.string().optional(),
});

export const gbpReviewSchema = z.looseObject({
  /**
   * The full resource name — stable across edits, which is exactly what
   * dedupe's exact path keys on. The pattern check makes a truncated or
   * re-shaped name fail here, not three stages later.
   */
  name: z.string().regex(GBP_REVIEW_NAME_PATTERN),
  /** Absent for anonymized reviewers on some surfaces — tolerated. */
  reviewer: gbpReviewerSchema.optional(),
  starRating: starRatingSchema,
  /** Absent for star-only reviews (proto3 omits empty fields). */
  comment: z.string().optional(),
  createTime: z.iso.datetime({ offset: true }),
  updateTime: z.iso.datetime({ offset: true }),
  reviewReply: gbpReviewReplySchema.optional(),
});

export type GbpReviewPayload = z.infer<typeof gbpReviewSchema>;

/** v4 `reviews.list` response body. Empty fields omitted, proto3-style. */
export const gbpReviewsPageSchema = z.looseObject({
  reviews: z.array(gbpReviewSchema).optional(),
  averageRating: z.number().optional(),
  totalReviewCount: z.number().optional(),
  nextPageToken: z.string().optional(),
});

export type GbpReviewsPage = z.infer<typeof gbpReviewsPageSchema>;

/** Envelope discriminator — the poller (#123) stores exactly this value. */
export const GOOGLE_REVIEWS_ARTIFACT_KIND = "gbp.reviews.page" as const;

/**
 * The stored-artifact envelope (see module doc). Built by the poller
 * (#123), consumed by `googleReviewsAdapter` (./adapter.ts).
 * `looseObject` so the poller may add context fields without breaking
 * already-stored artifacts or this adapter.
 */
export const googleReviewsArtifactSchema = z.looseObject({
  kind: z.literal(GOOGLE_REVIEWS_ARTIFACT_KIND),
  envelopeVersion: z.literal(1),
  practiceId: z.uuid(),
  googleLocationName: z.string().regex(GBP_LOCATION_NAME_PATTERN),
  fetchedAt: z.iso.datetime({ offset: true }),
  page: gbpReviewsPageSchema,
});

export type GoogleReviewsArtifact = z.infer<typeof googleReviewsArtifactSchema>;
