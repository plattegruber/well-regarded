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
  markSourceConnectionNeedsReauth,
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
