/**
 * Google Business Profile location discovery + mapping contract (issue
 * #121, Epic #7).
 *
 * One Google connection can expose several accounts and many locations —
 * some verified, some not, some irrelevant. After the OAuth connect (#118)
 * we discover what Google has and let the practice map Google locations
 * onto OUR `locations` rows; everything downstream (polling #123, signal
 * attribution, Presence) hangs off that mapping.
 *
 * **Storage decision (issue #121 requirement 3): jsonb-in-metadata.** Both
 * the discovered snapshot (`googleLocations`) and the mapping decisions
 * (`locationMappings`) live inside `source_connections.metadata` — a
 * separate mapping table isn't warranted for one integration. Revisit when
 * a second polling integration lands. The metadata column is shared with
 * other writers (#123 stores its per-location sync cursors there), so
 * writers must patch their own keys (see
 * `patchSourceConnectionMetadata` in `@wellregarded/db`), never replace
 * the whole object.
 *
 * Identity: Google's Business Information v1 location resource name
 * (`locations/{id}`) is the stable key — always the full resource name,
 * never the display title. The v4 reviews surface addresses locations as
 * `accounts/{a}/locations/{l}`; `googleV4LocationName` joins the two.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Discovered snapshot — `source_connections.metadata.googleLocations`
// ---------------------------------------------------------------------------

/**
 * Verified status of a Google location. The Business Information v1
 * `location` carries no simple `verificationState` string; discovery reads
 * `metadata.hasVoiceOfMerchant` (ADR 0002, #121 adjustment). Unverified
 * locations can never be mapped: Google doesn't reliably expose reviews for
 * them and hard-blocks replies (#127).
 */
export const GOOGLE_LOCATION_VERIFICATION_STATES = [
  "verified",
  "unverified",
] as const;
export type GoogleLocationVerificationState =
  (typeof GOOGLE_LOCATION_VERIFICATION_STATES)[number];

/**
 * One Google location as discovered via `listAccounts` + `listLocations`
 * (`@wellregarded/sources`). The snapshot is refreshed wholesale on each
 * discovery run; mappings are stored separately and survive refreshes.
 */
export const googleDiscoveredLocationSchema = z.object({
  /** Business Information v1 resource name (`locations/{id}`) — the stable identity key. */
  googleLocationName: z.string().min(1),
  /**
   * Owning account's resource name (`accounts/{id}`). v1 locations don't
   * carry it; discovery records which account it listed the location under.
   * The poller (#123) needs it to build the v4 reviews parent.
   */
  googleAccountName: z.string().min(1),
  /** The account's human-readable name — annotates multi-account (agency/owner) setups in the UI. */
  accountDisplayName: z.string(),
  /** The location's display title ("Cedar Ridge Dental — Downtown"). Never an identity. */
  title: z.string(),
  /** Formatted single-line address ("412 Cedar Ridge Ave, Suite 200, Grand Rapids, MI 49503"); empty when Google has none. */
  address: z.string(),
  verificationState: z.enum(GOOGLE_LOCATION_VERIFICATION_STATES),
  /** ISO timestamp of the discovery run that produced this entry. */
  discoveredAt: z.string(),
});
export type GoogleDiscoveredLocation = z.infer<
  typeof googleDiscoveredLocationSchema
>;

// ---------------------------------------------------------------------------
// Mapping decisions — `source_connections.metadata.locationMappings`
// ---------------------------------------------------------------------------

/**
 * One mapping decision. `locationId = null` means "don't import" — a
 * deliberate skip, distinct from a location that simply has no entry yet
 * (new/undecided). One Google location maps to at most one of our
 * locations (enforced by there being one entry per `googleLocationName`);
 * two Google locations MAY map to the same our-location (relocated-listing
 * edge case — allowed, the UI shows an informational note).
 */
export const googleLocationMappingSchema = z.object({
  /** `locations/{id}` — must exist in the discovered snapshot when written. */
  googleLocationName: z.string().min(1),
  /** Our `locations.id`, or null for a deliberate "don't import". */
  locationId: z.uuid().nullable(),
  /** Staff member who made the decision; null for system writes. */
  mappedBy: z.uuid().nullable(),
  /** ISO timestamp of the decision. */
  mappedAt: z.string(),
});
export type GoogleLocationMapping = z.infer<typeof googleLocationMappingSchema>;

/**
 * The #121 slice of `source_connections.metadata`. Loose on purpose:
 * other keys (e.g. #123's sync cursors) coexist in the same jsonb object
 * and must round-trip untouched.
 */
export const googleConnectionMetadataSchema = z.looseObject({
  googleLocations: z.array(googleDiscoveredLocationSchema).optional(),
  locationMappings: z.array(googleLocationMappingSchema).optional(),
});
export type GoogleConnectionMetadata = z.infer<
  typeof googleConnectionMetadataSchema
>;

/**
 * Read the #121 slice out of a connection's `metadata` jsonb, tolerating
 * absence and malformed content (both read as "nothing discovered/mapped
 * yet" — the UI offers a refresh; nothing downstream should crash on a
 * hand-edited row).
 */
export function parseGoogleConnectionMetadata(metadata: unknown): {
  googleLocations: GoogleDiscoveredLocation[];
  locationMappings: GoogleLocationMapping[];
} {
  const parsed = googleConnectionMetadataSchema.safeParse(metadata);
  if (!parsed.success) return { googleLocations: [], locationMappings: [] };
  return {
    googleLocations: parsed.data.googleLocations ?? [],
    locationMappings: parsed.data.locationMappings ?? [],
  };
}

/**
 * Join the two resource-name forms: the v4 reviews surface addresses a
 * location as `accounts/{a}/locations/{l}`, while Business Information v1
 * names it `locations/{l}` under a separately-listed account.
 */
export function googleV4LocationName(
  googleAccountName: string,
  googleLocationName: string,
): string {
  return `${googleAccountName}/${googleLocationName}`;
}

// ---------------------------------------------------------------------------
// Auto-suggest matching (issue #121 requirement 4 + implementation notes)
// ---------------------------------------------------------------------------

/**
 * Normalize a name/address fragment for matching: lowercase, strip
 * punctuation, drop suite/unit designators, collapse whitespace. Simple
 * normalized string comparison by design — no AI, no fuzzy scoring: a
 * wrong pre-selection is worse than none.
 */
export function normalizeForMatching(value: string): string {
  return (
    value
      .toLowerCase()
      // Suite/unit designators and their token: "Suite 200", "Ste. 4B", "Unit 12", "# 5".
      // (`\b` can't sit before "#" — it's not a word character.)
      .replace(/(?:\b(?:suite|ste|unit|apt|bldg|building)\.?|#)\s*[\w-]*/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Best-effort split of the snapshot's formatted single-line address
 * ("412 Cedar Ridge Ave, Suite 200, Grand Rapids, MI 49503" — the shape
 * discovery writes) back into our `locations` columns, for prefilling the
 * mapping screen's create-new-location form. Prefill only — the staff
 * member sees and can correct every field before saving.
 */
export function splitFormattedAddress(address: string): {
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
} {
  const segments = address
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length < 3) {
    return {
      addressLine1: segments[0] ?? null,
      city: segments.length === 2 ? (segments[1] ?? null) : null,
      state: null,
      postalCode: null,
    };
  }
  const last = segments[segments.length - 1] ?? "";
  // Discovery renders the tail as "administrativeArea postalCode".
  const regionMatch = last.match(/^(\S+)\s+(\S+)$/);
  return {
    addressLine1: segments.slice(0, -2).join(", ") || null,
    city: segments[segments.length - 2] ?? null,
    state: regionMatch ? (regionMatch[1] ?? null) : last || null,
    postalCode: regionMatch ? (regionMatch[2] ?? null) : null,
  };
}

/** The fields of our `locations` rows that matching compares against. */
export interface MatchableLocation {
  id: string;
  name: string;
  addressLine1: string | null;
}

/**
 * Suggest one of our locations for a discovered Google location, or null.
 *
 * A candidate matches on normalized name equality or normalized
 * first-address-line equality (Google's first address line vs our
 * `address_line1`). Suggest only on an unambiguous single match; two or
 * more matches — or none — yield null.
 */
export function suggestLocationId(
  discovered: Pick<GoogleDiscoveredLocation, "title" | "address">,
  candidates: readonly MatchableLocation[],
): string | null {
  const googleName = normalizeForMatching(discovered.title);
  // The formatted address is "line1, line2?, city, state zip" — the first
  // comma-separated segment is the street line.
  const googleAddressLine = normalizeForMatching(
    discovered.address.split(",")[0] ?? "",
  );

  const matches = candidates.filter((candidate) => {
    const name = normalizeForMatching(candidate.name);
    const addressLine = candidate.addressLine1
      ? normalizeForMatching(candidate.addressLine1)
      : "";
    const nameMatch = googleName.length > 0 && name === googleName;
    const addressMatch =
      googleAddressLine.length > 0 &&
      addressLine.length > 0 &&
      addressLine === googleAddressLine;
    return nameMatch || addressMatch;
  });

  return matches.length === 1 && matches[0] ? matches[0].id : null;
}
