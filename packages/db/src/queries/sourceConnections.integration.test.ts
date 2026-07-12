/**
 * `source_connections` round-trip against real Postgres (issue #118):
 * migration 0015's shape, the (practice_id, kind) uniqueness, and the
 * credential-custody rules the query helpers encode — re-auth preserves
 * `metadata`, disconnect erases credentials, `needs_reauth` only
 * transitions from `active`.
 */

import { decryptField, encryptField } from "@wellregarded/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  practice,
  sourceConnection,
  staffMember,
  TEST_KEYRING,
} from "../../test/factories.js";
import { pgError, setupTestDb } from "../../test/harness.js";
import { sourceConnections } from "../schema/sourceConnections.js";
import {
  disconnectSourceConnection,
  getSourceConnection,
  getSourceConnectionById,
  listActiveSourceConnections,
  markSourceConnectionNeedsReauth,
  patchSourceConnectionMetadata,
  setSourceConnectionLastSyncAt,
  upsertSourceConnection,
} from "./sourceConnections.js";

const SCOPE = "https://www.googleapis.com/auth/business.manage";

async function encrypted(refreshToken: string): Promise<string> {
  return encryptField(
    JSON.stringify({ refreshToken, obtainedAt: new Date().toISOString() }),
    TEST_KEYRING,
  );
}

describe("source_connections (integration)", () => {
  const t = setupTestDb();

  it("round-trips a row whose credentials decrypt back", async () => {
    const row = await sourceConnection(t.db);
    const fetched = await getSourceConnection(t.db, row.practiceId, "google");
    expect(fetched?.id).toBe(row.id);
    expect(fetched?.status).toBe("active");
    expect(fetched?.scopes).toEqual([SCOPE]);
    expect(fetched?.metadata).toEqual({});
    expect(fetched?.lastSyncAt).toBeNull();

    if (!fetched?.encryptedCredentials) throw new Error("expected ciphertext");
    const plain = JSON.parse(
      await decryptField(fetched.encryptedCredentials, TEST_KEYRING),
    ) as { refreshToken: string };
    expect(plain.refreshToken).toMatch(/^test-refresh-token-/);
  });

  it("enforces one connection per (practice, kind)", async () => {
    const row = await sourceConnection(t.db);
    const { code } = await pgError(
      sourceConnection(t.db, { practiceId: row.practiceId }),
    );
    expect(code).toBe("23505"); // unique_violation
  });

  it("upsert re-auth: replaces credentials, restores active, preserves metadata", async () => {
    const p = await practice(t.db);
    const firstStaff = await staffMember(t.db, { practiceId: p.id });
    const first = await upsertSourceConnection(t.db, {
      practiceId: p.id,
      kind: "google",
      encryptedCredentials: await encrypted("first-token"),
      scopes: [SCOPE],
      connectedBy: firstStaff.id,
    });

    // #121 writes its location mapping here; a later poller failure marks
    // needs_reauth — both must survive the re-auth upsert.
    const metadata = { googleLocations: [{ name: "locations/1" }] };
    await t.db
      .update(sourceConnections)
      .set({ metadata, status: "needs_reauth" })
      .where(eq(sourceConnections.id, first.id));

    const secondStaff = await staffMember(t.db, { practiceId: p.id });
    const second = await upsertSourceConnection(t.db, {
      practiceId: p.id,
      kind: "google",
      encryptedCredentials: await encrypted("second-token"),
      scopes: [SCOPE],
      connectedBy: secondStaff.id,
    });

    expect(second.id).toBe(first.id); // in place, not a new row
    expect(second.status).toBe("active");
    expect(second.metadata).toEqual(metadata);
    expect(second.connectedBy).toBe(secondStaff.id);
    if (!second.encryptedCredentials) throw new Error("expected ciphertext");
    const plain = JSON.parse(
      await decryptField(second.encryptedCredentials, TEST_KEYRING),
    ) as { refreshToken: string };
    expect(plain.refreshToken).toBe("second-token");
  });

  it("needs_reauth transitions only from active", async () => {
    const row = await sourceConnection(t.db);
    const marked = await markSourceConnectionNeedsReauth(t.db, row.id);
    expect(marked?.status).toBe("needs_reauth");

    // Idempotent: already needs_reauth → no transition.
    expect(await markSourceConnectionNeedsReauth(t.db, row.id)).toBeNull();

    // A disconnected row must never be resurrected into needs_reauth.
    const other = await sourceConnection(t.db);
    await disconnectSourceConnection(t.db, other.practiceId, "google");
    expect(await markSourceConnectionNeedsReauth(t.db, other.id)).toBeNull();
    const after = await getSourceConnection(t.db, other.practiceId, "google");
    expect(after?.status).toBe("disconnected");
  });

  it("disconnect erases credentials and is a no-op the second time", async () => {
    const row = await sourceConnection(t.db);
    const disconnected = await disconnectSourceConnection(
      t.db,
      row.practiceId,
      "google",
    );
    expect(disconnected?.status).toBe("disconnected");
    expect(disconnected?.encryptedCredentials).toBeNull();

    expect(
      await disconnectSourceConnection(t.db, row.practiceId, "google"),
    ).toBeNull();

    // Unknown practice/kind combos are nulls, not errors.
    const p = await practice(t.db);
    expect(await disconnectSourceConnection(t.db, p.id, "google")).toBeNull();
  });
});

describe("poller queries (issue #123, integration)", () => {
  const t = setupTestDb();

  it("getSourceConnectionById fetches by pk; null for unknown", async () => {
    const row = await sourceConnection(t.db);
    expect((await getSourceConnectionById(t.db, row.id))?.id).toBe(row.id);
    expect(
      await getSourceConnectionById(
        t.db,
        "7b1e64a0-0000-4000-8000-000000000000",
      ),
    ).toBeNull();
  });

  it("listActiveSourceConnections returns only active google rows, id-ordered", async () => {
    const active1 = await sourceConnection(t.db);
    const active2 = await sourceConnection(t.db);
    const reauth = await sourceConnection(t.db, { status: "needs_reauth" });
    const disconnected = await sourceConnection(t.db, {
      status: "disconnected",
      encryptedCredentials: null,
    });

    const listed = await listActiveSourceConnections(t.db, "google");
    const ids = listed.map((row) => row.id);
    expect(ids).toContain(active1.id);
    expect(ids).toContain(active2.id);
    expect(ids).not.toContain(reauth.id);
    expect(ids).not.toContain(disconnected.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("the poller's syncCursors patch never disturbs the #121 keys in the same jsonb", async () => {
    // The metadata object is shared: #121 owns googleLocations +
    // locationMappings, #123 owns syncCursors — each writer patches only
    // its own top-level key (patchSourceConnectionMetadata).
    const row = await sourceConnection(t.db, {
      metadata: {
        googleLocations: [
          { googleLocationName: "locations/1" },
          { googleLocationName: "locations/2" },
        ],
        locationMappings: [
          {
            googleLocationName: "locations/1",
            locationId: "5d4c3b2a-1908-4756-8493-a1b2c3d4e5f6",
          },
        ],
      },
    });

    await patchSourceConnectionMetadata(t.db, row.id, {
      syncCursors: { "locations/1": "2026-07-01T00:00:00.000Z" },
    });
    // Advance: the poller re-patches its own key with the updated map.
    await patchSourceConnectionMetadata(t.db, row.id, {
      syncCursors: {
        "locations/1": "2026-07-03T00:00:00.000Z",
        "locations/2": "2026-07-02T00:00:00.000Z",
      },
    });

    const [updated] = await t.db
      .select()
      .from(sourceConnections)
      .where(eq(sourceConnections.id, row.id));
    const metadata = updated?.metadata as {
      syncCursors: Record<string, string>;
      googleLocations: unknown[];
      locationMappings: unknown[];
    };
    expect(metadata.syncCursors).toEqual({
      "locations/1": "2026-07-03T00:00:00.000Z",
      "locations/2": "2026-07-02T00:00:00.000Z",
    });
    expect(metadata.googleLocations).toHaveLength(2);
    expect(metadata.locationMappings).toHaveLength(1);
  });

  it("setSourceConnectionLastSyncAt stamps the poll time", async () => {
    const row = await sourceConnection(t.db);
    const at = new Date("2026-07-11T06:00:00.000Z");
    await setSourceConnectionLastSyncAt(t.db, row.id, at);
    const [updated] = await t.db
      .select()
      .from(sourceConnections)
      .where(eq(sourceConnections.id, row.id));
    expect(updated?.lastSyncAt?.toISOString()).toBe(at.toISOString());
  });
});
