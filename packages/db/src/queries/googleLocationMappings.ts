/**
 * Google location mapping writes (issue #121, Epic #7).
 *
 * One shared implementation behind both mutation surfaces — the API
 * worker's `PUT /integrations/google/mappings` and the dashboard's mapping
 * screen action — so the validation rules can't drift between them:
 *
 * - every `googleLocationName` must exist in the discovered snapshot
 *   (`metadata.googleLocations`) and appear at most once in the request;
 * - a mapped `locationId` must belong to the practice;
 * - unverified Google locations cannot be mapped (reviews aren't reliably
 *   available; Google hard-blocks replies) — they can only be skipped;
 * - one Google location maps to at most one of our locations (the entry
 *   shape enforces it); two Google locations MAY map to the same
 *   our-location (relocated-listing edge case — allowed).
 *
 * Storage is jsonb-in-metadata (`metadata.locationMappings` — see
 * `googleLocations.ts` in `@wellregarded/core` for the decision); writes go
 * through `patchSourceConnectionMetadata` so other metadata keys (#123's
 * sync cursors) survive. The mapping set is replaced wholesale with the
 * decided entries; entries whose decision is unchanged keep their original
 * `mappedBy`/`mappedAt`.
 */

import {
  type Actor,
  type GoogleLocationMapping,
  parseGoogleConnectionMetadata,
} from "@wellregarded/core";
import { and, eq, inArray } from "drizzle-orm";

import { audit } from "../audit.js";
import type { Db } from "../client.js";
import { sourceConnections } from "../schema/sourceConnections.js";
import { locations } from "../schema/tenancy.js";
import type { SourceConnection } from "./sourceConnections.js";
import { patchSourceConnectionMetadata } from "./sourceConnections.js";
import type { Location } from "./tenancy.js";

/** What to do with one discovered Google location. */
export type GoogleMappingDecision =
  /** Map to an existing location of ours. */
  | { kind: "map"; locationId: string }
  /** Deliberately don't import (distinct from "no decision yet"). */
  | { kind: "skip" }
  /** Create a `locations` row inline (from the Google title/address), then map to it. */
  | {
      kind: "create";
      name: string;
      addressLine1?: string | null | undefined;
      city?: string | null | undefined;
      state?: string | null | undefined;
      postalCode?: string | null | undefined;
    };

export interface GoogleMappingEntry {
  googleLocationName: string;
  decision: GoogleMappingDecision;
}

export interface SaveGoogleLocationMappingsInput {
  practiceId: string;
  /** Audit actor; staff actors are also recorded as `mappedBy`. */
  actor: Actor;
  /**
   * The full decided set — mappings are replaced wholesale; discovered
   * locations without an entry read as "undecided".
   */
  entries: GoogleMappingEntry[];
}

export type GoogleMappingIssueCode =
  | "unknown_google_location"
  | "duplicate_google_location"
  | "unverified_google_location"
  | "unknown_location";

export interface GoogleMappingIssue {
  code: GoogleMappingIssueCode;
  googleLocationName: string;
  message: string;
}

export type SaveGoogleLocationMappingsResult =
  | {
      status: "saved";
      connection: SourceConnection;
      mappings: GoogleLocationMapping[];
      createdLocations: Location[];
    }
  /** No google connection (or it is disconnected) for this practice. */
  | { status: "not_found" }
  /** Validation failed; nothing was written. */
  | { status: "invalid"; issues: GoogleMappingIssue[] };

/**
 * Validate and persist the practice's Google location mappings in one
 * transaction (inline location creation + metadata patch + audit entries).
 */
export async function saveGoogleLocationMappings(
  db: Db,
  input: SaveGoogleLocationMappingsInput,
): Promise<SaveGoogleLocationMappingsResult> {
  return db.transaction(async (tx) => {
    // Lock the row: two concurrent saves must serialize, or the second
    // metadata patch silently wins over a snapshot the first invalidated.
    const [connection] = await tx
      .select()
      .from(sourceConnections)
      .where(
        and(
          eq(sourceConnections.practiceId, input.practiceId),
          eq(sourceConnections.kind, "google"),
        ),
      )
      .for("update");
    if (!connection || connection.status === "disconnected") {
      return { status: "not_found" as const };
    }

    const { googleLocations, locationMappings: existing } =
      parseGoogleConnectionMetadata(connection.metadata);
    const snapshot = new Map(
      googleLocations.map((l) => [l.googleLocationName, l]),
    );

    // -- Validation (all issues collected; nothing written on any failure).
    const issues: GoogleMappingIssue[] = [];
    const seen = new Set<string>();
    for (const entry of input.entries) {
      const name = entry.googleLocationName;
      if (seen.has(name)) {
        issues.push({
          code: "duplicate_google_location",
          googleLocationName: name,
          message: `${name} appears more than once — one decision per Google location.`,
        });
        continue;
      }
      seen.add(name);
      const discovered = snapshot.get(name);
      if (!discovered) {
        issues.push({
          code: "unknown_google_location",
          googleLocationName: name,
          message: `${name} is not in the discovered snapshot — refresh locations and retry.`,
        });
        continue;
      }
      if (
        discovered.verificationState !== "verified" &&
        entry.decision.kind !== "skip"
      ) {
        issues.push({
          code: "unverified_google_location",
          googleLocationName: name,
          message: `${name} is unverified on Google — it cannot be mapped, only skipped.`,
        });
      }
    }

    // Referenced locations must belong to THIS practice.
    const referencedIds = input.entries.flatMap((entry) =>
      entry.decision.kind === "map" ? [entry.decision.locationId] : [],
    );
    const ownedIds = new Set(
      referencedIds.length === 0
        ? []
        : (
            await tx
              .select({ id: locations.id })
              .from(locations)
              .where(
                and(
                  eq(locations.practiceId, input.practiceId),
                  inArray(locations.id, referencedIds),
                ),
              )
          ).map((row) => row.id),
    );
    for (const entry of input.entries) {
      if (
        entry.decision.kind === "map" &&
        !ownedIds.has(entry.decision.locationId)
      ) {
        issues.push({
          code: "unknown_location",
          googleLocationName: entry.googleLocationName,
          message: `${entry.googleLocationName} maps to a location that doesn't exist in this practice.`,
        });
      }
    }
    if (issues.length > 0) return { status: "invalid" as const, issues };

    // -- Inline location creation (requirement 4), audited per row.
    const mappedBy = input.actor.type === "staff" ? input.actor.id : null;
    const createdLocations: Location[] = [];
    const resolvedLocationId = new Map<string, string | null>();
    for (const entry of input.entries) {
      if (entry.decision.kind === "map") {
        resolvedLocationId.set(
          entry.googleLocationName,
          entry.decision.locationId,
        );
      } else if (entry.decision.kind === "skip") {
        resolvedLocationId.set(entry.googleLocationName, null);
      } else {
        const [created] = await tx
          .insert(locations)
          .values({
            practiceId: input.practiceId,
            name: entry.decision.name,
            addressLine1: entry.decision.addressLine1 ?? null,
            city: entry.decision.city ?? null,
            state: entry.decision.state ?? null,
            postalCode: entry.decision.postalCode ?? null,
          })
          .returning();
        if (!created) throw new Error("locations insert returned no row");
        createdLocations.push(created);
        resolvedLocationId.set(entry.googleLocationName, created.id);
        await audit(tx, {
          practiceId: input.practiceId,
          actor: input.actor,
          action: "location.created",
          entityType: "locations",
          entityId: created.id,
          payload: {
            source: "google_location_mapping",
            googleLocationName: entry.googleLocationName,
          },
        });
      }
    }

    // -- Build the replacement mapping set, preserving provenance where the
    //    decision didn't change.
    const previous = new Map(existing.map((m) => [m.googleLocationName, m]));
    const now = new Date().toISOString();
    const mappings: GoogleLocationMapping[] = input.entries.map((entry) => {
      const locationId =
        resolvedLocationId.get(entry.googleLocationName) ?? null;
      const before = previous.get(entry.googleLocationName);
      if (before && before.locationId === locationId) return before;
      return {
        googleLocationName: entry.googleLocationName,
        locationId,
        mappedBy,
        mappedAt: now,
      };
    });

    const patched = await patchSourceConnectionMetadata(tx, connection.id, {
      locationMappings: mappings,
    });
    if (!patched) throw new Error("connection row vanished mid-transaction");

    // -- One audit entry per save, summarizing the change (references only).
    const after = new Map(mappings.map((m) => [m.googleLocationName, m]));
    const added = mappings.filter(
      (m) => !previous.has(m.googleLocationName),
    ).length;
    const changed = mappings.filter((m) => {
      const before = previous.get(m.googleLocationName);
      return before !== undefined && before.locationId !== m.locationId;
    }).length;
    const removed = existing.filter(
      (m) => !after.has(m.googleLocationName),
    ).length;
    await audit(tx, {
      practiceId: input.practiceId,
      actor: input.actor,
      action: "source_connection.mappings_updated",
      entityType: "source_connections",
      entityId: connection.id,
      payload: {
        kind: "google",
        added,
        changed,
        removed,
        total: mappings.length,
        mapped: mappings.filter((m) => m.locationId !== null).length,
        skipped: mappings.filter((m) => m.locationId === null).length,
        createdLocationIds: createdLocations.map((l) => l.id),
      },
    });

    return {
      status: "saved" as const,
      connection: patched,
      mappings,
      createdLocations,
    };
  });
}
