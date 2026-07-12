/**
 * The polling contract over the #121 location mapping (issue #121
 * requirement 7, consumed by the poller, #123).
 *
 * The mapping and the discovered snapshot live in
 * `source_connections.metadata` (`locationMappings` / `googleLocations` —
 * see `googleLocations.ts` in `@wellregarded/core` for the storage
 * decision). `getActiveMappings` reduces them to the list of locations the
 * poller may fetch reviews for: **mapped AND verified only**. Everything
 * else is excluded with a machine-readable reason — the poller must emit a
 * debug log line stating what was excluded and why on each poll, so a
 * silent "no reviews for that office" is always explainable.
 */

import {
  type GoogleDiscoveredLocation,
  googleV4LocationName,
  parseGoogleConnectionMetadata,
} from "@wellregarded/core";

/** A location the poller polls. */
export interface ActiveGoogleMapping {
  /** Business Information v1 resource name (`locations/{id}`) — the mapping key. */
  googleLocationName: string;
  /** Owning account resource name (`accounts/{id}`). */
  googleAccountName: string;
  /**
   * v4 account-scoped resource name (`accounts/{a}/locations/{l}`) — the
   * `reviews.list` parent AND the artifact envelope's `googleLocationName`
   * (see schema.ts).
   */
  v4LocationName: string;
  /** Our `locations.id` the polled reviews attribute to. */
  locationId: string;
}

/** Why a discovered/mapped location is NOT polled. */
export type GoogleMappingExclusionReason =
  /** Discovered but no decision recorded yet. */
  | "unmapped"
  /** Staff explicitly chose "don't import". */
  | "skipped"
  /** Not verified on Google — reviews unreliable, replies hard-blocked. */
  | "unverified"
  /** A mapping exists but its location vanished from the latest snapshot. */
  | "not_in_snapshot";

export interface ExcludedGoogleLocation {
  googleLocationName: string;
  reason: GoogleMappingExclusionReason;
}

export interface ActiveMappingsResult {
  active: ActiveGoogleMapping[];
  /** For the poller's per-poll debug log line — never silently dropped. */
  excluded: ExcludedGoogleLocation[];
}

/**
 * Reduce a connection's metadata to what the poller may poll. Pure — pass
 * the `source_connections` row's `metadata` value (or the whole row's
 * `{ metadata }`); tolerant of absent/malformed metadata (everything reads
 * as excluded).
 */
export function getActiveMappings(connection: {
  metadata: unknown;
}): ActiveMappingsResult {
  const { googleLocations, locationMappings } = parseGoogleConnectionMetadata(
    connection.metadata,
  );
  const snapshotByName = new Map<string, GoogleDiscoveredLocation>(
    googleLocations.map((location) => [location.googleLocationName, location]),
  );
  const mappingByName = new Map(
    locationMappings.map((mapping) => [mapping.googleLocationName, mapping]),
  );

  const active: ActiveGoogleMapping[] = [];
  const excluded: ExcludedGoogleLocation[] = [];

  for (const location of googleLocations) {
    const mapping = mappingByName.get(location.googleLocationName);
    if (location.verificationState !== "verified") {
      excluded.push({
        googleLocationName: location.googleLocationName,
        reason: "unverified",
      });
      continue;
    }
    if (!mapping) {
      excluded.push({
        googleLocationName: location.googleLocationName,
        reason: "unmapped",
      });
      continue;
    }
    if (mapping.locationId === null) {
      excluded.push({
        googleLocationName: location.googleLocationName,
        reason: "skipped",
      });
      continue;
    }
    active.push({
      googleLocationName: location.googleLocationName,
      googleAccountName: location.googleAccountName,
      v4LocationName: googleV4LocationName(
        location.googleAccountName,
        location.googleLocationName,
      ),
      locationId: mapping.locationId,
    });
  }

  // Mappings pointing at locations no longer in the snapshot are kept in
  // metadata (a transient Google glitch must not erase decisions) but are
  // never polled — surface them in the exclusion log.
  for (const mapping of locationMappings) {
    if (!snapshotByName.has(mapping.googleLocationName)) {
      excluded.push({
        googleLocationName: mapping.googleLocationName,
        reason: "not_in_snapshot",
      });
    }
  }

  return { active, excluded };
}
