/**
 * Mapping CRUD integration tests (issue #121): validation rules, inline
 * location creation, metadata-patch isolation (other writers' keys
 * survive), provenance preservation, and audit entries — against real
 * Postgres via the template-clone harness.
 */

import type {
  Actor,
  GoogleDiscoveredLocation,
  GoogleLocationMapping,
} from "@wellregarded/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  location,
  practice,
  sourceConnection,
  staffMember,
} from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import { auditLog } from "../schema/audit.js";
import { sourceConnections } from "../schema/sourceConnections.js";
import { locations } from "../schema/tenancy.js";
import { saveGoogleLocationMappings } from "./googleLocationMappings.js";
import { patchSourceConnectionMetadata } from "./sourceConnections.js";

const t = setupTestDb();

function discovered(
  overrides: Partial<GoogleDiscoveredLocation> = {},
): GoogleDiscoveredLocation {
  return {
    googleLocationName: "locations/101",
    googleAccountName: "accounts/1",
    accountDisplayName: "Cedar Ridge Dental Group",
    title: "Downtown",
    address: "412 Cedar Ridge Ave, Grand Rapids, MI 49503",
    verificationState: "verified",
    discoveredAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A practice + staff actor + google connection seeded with a snapshot. */
async function scenario(snapshot: GoogleDiscoveredLocation[]) {
  const p = await practice(t.db);
  const staff = await staffMember(t.db, { practiceId: p.id });
  const connection = await sourceConnection(t.db, {
    practiceId: p.id,
    connectedBy: staff.id,
    metadata: {
      googleLocations: snapshot,
      // Another writer's key (#123's cursor) — must survive mapping saves.
      syncCursors: { "locations/101": "2026-07-01T00:00:00.000Z" },
    },
  });
  const actor: Actor = { type: "staff", id: staff.id };
  return { p, staff, connection, actor };
}

async function auditActions(practiceId: string): Promise<string[]> {
  const rows = await t.db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(eq(auditLog.practiceId, practiceId))
    .orderBy(auditLog.createdAt);
  return rows.map((r) => r.action);
}

describe("saveGoogleLocationMappings (integration)", () => {
  it("maps, skips, and creates inline — audited, other metadata keys intact", async () => {
    const { p, staff, actor } = await scenario([
      discovered({ googleLocationName: "locations/101" }),
      discovered({ googleLocationName: "locations/102", title: "Westside" }),
      discovered({
        googleLocationName: "locations/103",
        title: "North Park",
        address: "2301 Plainfield Ave NE, Grand Rapids, MI 49505",
      }),
    ]);
    const ours = await location(t.db, { practiceId: p.id, name: "Downtown" });

    const result = await saveGoogleLocationMappings(t.db, {
      practiceId: p.id,
      actor,
      entries: [
        {
          googleLocationName: "locations/101",
          decision: { kind: "map", locationId: ours.id },
        },
        { googleLocationName: "locations/102", decision: { kind: "skip" } },
        {
          googleLocationName: "locations/103",
          decision: {
            kind: "create",
            name: "North Park",
            addressLine1: "2301 Plainfield Ave NE",
            city: "Grand Rapids",
            state: "MI",
            postalCode: "49505",
          },
        },
      ],
    });

    if (result.status !== "saved") throw new Error(`got ${result.status}`);
    expect(result.createdLocations).toHaveLength(1);
    const created = result.createdLocations[0];
    expect(created?.name).toBe("North Park");
    expect(created?.practiceId).toBe(p.id);

    // The created row is a real locations row.
    const [row] = await t.db
      .select()
      .from(locations)
      .where(eq(locations.id, created?.id ?? ""));
    expect(row?.addressLine1).toBe("2301 Plainfield Ave NE");

    // Mappings persisted; the skip is a null locationId, not an absence.
    const metadata = result.connection.metadata as Record<string, unknown>;
    const mappings = metadata.locationMappings as GoogleLocationMapping[];
    expect(mappings).toHaveLength(3);
    expect(mappings.map((m) => [m.googleLocationName, m.locationId])).toEqual([
      ["locations/101", ours.id],
      ["locations/102", null],
      ["locations/103", created?.id],
    ]);
    expect(mappings.every((m) => m.mappedBy === staff.id)).toBe(true);

    // The other writer's metadata key (#123's cursors) survived the patch.
    expect(metadata.syncCursors).toEqual({
      "locations/101": "2026-07-01T00:00:00.000Z",
    });
    // The snapshot itself is untouched.
    expect(metadata.googleLocations).toHaveLength(3);

    expect(await auditActions(p.id)).toEqual([
      "location.created",
      "source_connection.mappings_updated",
    ]);
  });

  it("rejects unknown snapshot names, foreign locations, unverified maps, and duplicates — nothing written", async () => {
    const { p, actor, connection } = await scenario([
      discovered({ googleLocationName: "locations/101" }),
      discovered({
        googleLocationName: "locations/102",
        verificationState: "unverified",
      }),
    ]);
    const otherPractice = await practice(t.db);
    const foreign = await location(t.db, { practiceId: otherPractice.id });

    const result = await saveGoogleLocationMappings(t.db, {
      practiceId: p.id,
      actor,
      entries: [
        {
          googleLocationName: "locations/999",
          decision: { kind: "skip" },
        },
        {
          googleLocationName: "locations/101",
          decision: { kind: "map", locationId: foreign.id },
        },
        {
          googleLocationName: "locations/101",
          decision: { kind: "skip" },
        },
        {
          googleLocationName: "locations/102",
          decision: { kind: "create", name: "Nope" },
        },
      ],
    });

    if (result.status !== "invalid") throw new Error(`got ${result.status}`);
    expect(result.issues.map((i) => i.code).sort()).toEqual([
      "duplicate_google_location",
      "unknown_google_location",
      "unknown_location",
      "unverified_google_location",
    ]);

    // Nothing written: no mappings, no created location, no audit rows.
    const [after] = await t.db
      .select()
      .from(sourceConnections)
      .where(eq(sourceConnections.id, connection.id));
    if (!after) throw new Error("expected the connection row");
    expect(
      (after.metadata as Record<string, unknown>).locationMappings,
    ).toBeUndefined();
    expect(await auditActions(p.id)).toEqual([]);
    const rows = await t.db
      .select()
      .from(locations)
      .where(eq(locations.practiceId, p.id));
    expect(rows).toHaveLength(0);
  });

  it("allows an unverified location to be skipped", async () => {
    const { p, actor } = await scenario([
      discovered({
        googleLocationName: "locations/102",
        verificationState: "unverified",
      }),
    ]);
    const result = await saveGoogleLocationMappings(t.db, {
      practiceId: p.id,
      actor,
      entries: [
        { googleLocationName: "locations/102", decision: { kind: "skip" } },
      ],
    });
    expect(result.status).toBe("saved");
  });

  it("allows two Google locations to map to the same our-location", async () => {
    const { p, actor } = await scenario([
      discovered({ googleLocationName: "locations/101" }),
      discovered({ googleLocationName: "locations/102" }),
    ]);
    const ours = await location(t.db, { practiceId: p.id });
    const result = await saveGoogleLocationMappings(t.db, {
      practiceId: p.id,
      actor,
      entries: [
        {
          googleLocationName: "locations/101",
          decision: { kind: "map", locationId: ours.id },
        },
        {
          googleLocationName: "locations/102",
          decision: { kind: "map", locationId: ours.id },
        },
      ],
    });
    expect(result.status).toBe("saved");
  });

  it("preserves mappedBy/mappedAt for unchanged decisions, restamps changed ones", async () => {
    const { p, actor } = await scenario([
      discovered({ googleLocationName: "locations/101" }),
      discovered({ googleLocationName: "locations/102" }),
    ]);
    const ours = await location(t.db, { practiceId: p.id });

    const first = await saveGoogleLocationMappings(t.db, {
      practiceId: p.id,
      actor,
      entries: [
        {
          googleLocationName: "locations/101",
          decision: { kind: "map", locationId: ours.id },
        },
        { googleLocationName: "locations/102", decision: { kind: "skip" } },
      ],
    });
    if (first.status !== "saved") throw new Error("first save failed");

    const otherStaff = await staffMember(t.db, { practiceId: p.id });
    const second = await saveGoogleLocationMappings(t.db, {
      practiceId: p.id,
      actor: { type: "staff", id: otherStaff.id },
      entries: [
        {
          googleLocationName: "locations/101",
          decision: { kind: "map", locationId: ours.id }, // unchanged
        },
        {
          googleLocationName: "locations/102",
          decision: { kind: "map", locationId: ours.id }, // skip → map
        },
      ],
    });
    if (second.status !== "saved") throw new Error("second save failed");

    const byName = new Map(
      second.mappings.map((m) => [m.googleLocationName, m]),
    );
    expect(byName.get("locations/101")).toEqual(
      first.mappings.find((m) => m.googleLocationName === "locations/101"),
    );
    expect(byName.get("locations/102")?.mappedBy).toBe(otherStaff.id);
  });

  it("drops entries omitted from the set (back to undecided)", async () => {
    const { p, actor } = await scenario([
      discovered({ googleLocationName: "locations/101" }),
    ]);
    await saveGoogleLocationMappings(t.db, {
      practiceId: p.id,
      actor,
      entries: [
        { googleLocationName: "locations/101", decision: { kind: "skip" } },
      ],
    });
    const result = await saveGoogleLocationMappings(t.db, {
      practiceId: p.id,
      actor,
      entries: [],
    });
    if (result.status !== "saved") throw new Error("save failed");
    expect(result.mappings).toEqual([]);
  });

  it("returns not_found without a google connection", async () => {
    const p = await practice(t.db);
    const staff = await staffMember(t.db, { practiceId: p.id });
    const result = await saveGoogleLocationMappings(t.db, {
      practiceId: p.id,
      actor: { type: "staff", id: staff.id },
      entries: [],
    });
    expect(result.status).toBe("not_found");
  });
});

describe("patchSourceConnectionMetadata (integration)", () => {
  it("shallow-merges only the given keys", async () => {
    const row = await sourceConnection(t.db, {
      metadata: { locationMappings: [], syncCursors: { a: 1 } },
    });
    const patched = await patchSourceConnectionMetadata(t.db, row.id, {
      googleLocations: [],
    });
    expect(patched?.metadata).toEqual({
      locationMappings: [],
      syncCursors: { a: 1 },
      googleLocations: [],
    });
  });

  it("returns null for a missing connection", async () => {
    expect(
      await patchSourceConnectionMetadata(
        t.db,
        "00000000-0000-4000-8000-000000000000",
        {},
      ),
    ).toBeNull();
  });
});
