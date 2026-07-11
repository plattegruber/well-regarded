/**
 * Wire types for the fake GBP server (issue #130, Epic #7).
 *
 * These mirror the real Google Business Profile resource shapes documented
 * in ADR 0002 (docs/adr/0002-google-business-profile-integration.md §2):
 * the v4 `Review`/`ReviewReply` (reviews never migrated off
 * `mybusiness.googleapis.com/v4`), the Account Management v1 `Account`, and
 * the Business Information v1 `Location`. Field names and enum values are
 * the fidelity bar — any shape discovered wrong against real GBP gets fixed
 * HERE first so every test inherits the correction (see README.md).
 *
 * Proto3 JSON convention: Google omits absent/default-valued fields rather
 * than sending `null`/`0`/`""`. All optionals below are therefore genuinely
 * absent (`exactOptionalPropertyTypes` keeps us honest).
 */

/** v4 `StarRating` enum, exactly as documented. */
export const STAR_RATINGS = [
  "STAR_RATING_UNSPECIFIED",
  "ONE",
  "TWO",
  "THREE",
  "FOUR",
  "FIVE",
] as const;
export type StarRating = (typeof STAR_RATINGS)[number];

/** Numeric value of a star rating (UNSPECIFIED ratings count as 0). */
export function starRatingValue(rating: StarRating): number {
  return STAR_RATINGS.indexOf(rating);
}

/**
 * v4 `ReviewReply` — including the 2026 moderation fields: owner replies
 * are moderated since 2026-04-01 (`reviewReplyState`), with the rejection
 * reason (`policyViolation`) retrievable since 2026-07-01. A 200 from the
 * reply PUT does NOT mean the reply is live (ADR 0002 §2, #127 adjustment).
 */
export interface GbpReviewReply {
  /** Max 4096 bytes (bytes, not chars — UTF-8). */
  comment: string;
  updateTime: string;
  reviewReplyState?: ReviewReplyState;
  /** Rejection reason; only present when `reviewReplyState` is REJECTED. */
  policyViolation?: string;
}

export const REVIEW_REPLY_STATES = ["PENDING", "REJECTED", "APPROVED"] as const;
export type ReviewReplyState = (typeof REVIEW_REPLY_STATES)[number];

/** v4 `Reviewer`. Anonymized reviewers show as "A Google user". */
export interface GbpReviewer {
  displayName: string;
  profilePhotoUrl?: string;
  isAnonymous?: boolean;
}

/** v4 review media attachment (added 2026-04-20). */
export interface GbpReviewMediaItem {
  name: string;
  mediaFormat: "PHOTO" | "VIDEO";
  googleUrl: string;
}

/**
 * v4 `Review`. `name` is the full resource path
 * (`accounts/{a}/locations/{l}/reviews/{r}`) — the adapter (#125) uses it
 * verbatim as `sourceId`, so it must always be the full path.
 */
export interface GbpReview {
  name: string;
  reviewId: string;
  reviewer: GbpReviewer;
  starRating: StarRating;
  /** Absent for star-only reviews. */
  comment?: string;
  createTime: string;
  updateTime: string;
  reviewReply?: GbpReviewReply;
  reviewMediaItems?: GbpReviewMediaItem[];
}

/** v4 `reviews.list` response. Empty fields are omitted, proto3-style. */
export interface GbpReviewsListResponse {
  reviews?: GbpReview[];
  averageRating?: number;
  totalReviewCount?: number;
  nextPageToken?: string;
}

/** Account Management v1 `Account` (`name` is `accounts/{id}`). */
export interface GbpAccount {
  name: string;
  accountName: string;
  type: "PERSONAL" | "LOCATION_GROUP" | "USER_GROUP" | "ORGANIZATION";
  role?: "PRIMARY_OWNER" | "OWNER" | "MANAGER" | "SITE_MANAGER";
  verificationState?: "VERIFIED" | "UNVERIFIED" | "VERIFICATION_REQUESTED";
  vettedState?: "NOT_VETTED" | "VETTED" | "INVALID";
}

export interface GbpAccountsListResponse {
  accounts?: GbpAccount[];
  nextPageToken?: string;
}

/** google.type.TimeOfDay — zero-valued fields omitted, proto3-style. */
export interface GbpTimeOfDay {
  hours?: number;
  minutes?: number;
}

export type GbpDayOfWeek =
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY"
  | "SUNDAY";

export interface GbpTimePeriod {
  openDay: GbpDayOfWeek;
  openTime: GbpTimeOfDay;
  closeDay: GbpDayOfWeek;
  closeTime: GbpTimeOfDay;
}

export interface GbpCategory {
  /** e.g. `categories/gcid:dentist`. */
  name: string;
  displayName: string;
}

/**
 * Business Information v1 `Location` — the profile-fields surface for
 * Presence (#156): hours, links, categories; photo COUNT lives on the v4
 * media surface instead (`totalMediaItemCount`).
 *
 * Two real-API subtleties preserved deliberately:
 * - `name` is `locations/{id}` — NOT `accounts/{a}/locations/{l}`. The v4
 *   reviews path needs the account-scoped form; #121 must join the two.
 * - There is no simple `verificationState` string on a location. Verified
 *   status is read from `metadata.hasVoiceOfMerchant` (or the Verifications
 *   API `VoiceOfMerchantState` — the fake serves both).
 */
export interface GbpLocation {
  name: string;
  title: string;
  storefrontAddress?: GbpPostalAddress;
  phoneNumbers?: { primaryPhone: string; additionalPhones?: string[] };
  categories?: {
    primaryCategory: GbpCategory;
    additionalCategories?: GbpCategory[];
  };
  websiteUri?: string;
  regularHours?: { periods: GbpTimePeriod[] };
  specialHours?: {
    specialHourPeriods: Array<{
      startDate: { year: number; month: number; day: number };
      closed?: boolean;
      openTime?: GbpTimeOfDay;
      closeTime?: GbpTimeOfDay;
    }>;
  };
  profile?: { description: string };
  metadata?: GbpLocationMetadata;
}

/** google.type.PostalAddress subset GBP uses. */
export interface GbpPostalAddress {
  regionCode: string;
  languageCode?: string;
  postalCode?: string;
  administrativeArea?: string;
  locality?: string;
  addressLines?: string[];
}

export interface GbpLocationMetadata {
  /**
   * The verified-status capability flag (ADR 0002 #121 note). When false,
   * Google hard-blocks review replies on the location.
   */
  hasVoiceOfMerchant?: boolean;
  placeId?: string;
  mapsUri?: string;
  newReviewUri?: string;
}

export interface GbpLocationsListResponse {
  locations?: GbpLocation[];
  nextPageToken?: string;
  totalSize?: number;
}

/** Verifications v1 `VoiceOfMerchantState` (simplified — see README). */
export interface GbpVoiceOfMerchantState {
  hasVoiceOfMerchant?: boolean;
  hasBusinessAuthority?: boolean;
}

/** v4 media item (only the fields Presence needs). */
export interface GbpMediaItem {
  name: string;
  mediaFormat: "PHOTO" | "VIDEO";
  googleUrl: string;
}

export interface GbpMediaListResponse {
  mediaItems?: GbpMediaItem[];
  totalMediaItemCount?: number;
  nextPageToken?: string;
}

/** OAuth token endpoint success body (Google OAuth 2.0). */
export interface OauthTokenResponse {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: "Bearer";
  /** Only on authorization_code exchanges (with access_type=offline). */
  refresh_token?: string;
}

/** OAuth token endpoint error body. */
export interface OauthErrorResponse {
  error: string;
  error_description?: string;
}

/**
 * Google JSON error envelope used by the v1/v4 APIs (google.rpc.Status
 * rendered by the HTTP front end).
 */
export interface GoogleApiError {
  error: {
    code: number;
    message: string;
    status: string;
  };
}
