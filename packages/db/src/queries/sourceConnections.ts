/**
 * `source_connections` queries (issue #118, Epic #7).
 *
 * The write paths encode the credential-custody rules from the schema doc
 * comment: connect/re-auth replaces credentials in place WITHOUT touching
 * `metadata` (the #121 location mapping must survive re-auth), disconnect
 * NULLs the ciphertext (dead tokens are never kept), and `needs_reauth`
 * only ever transitions from `active` (a disconnected row stays
 * disconnected even if a stale poller sees `invalid_grant`).
 *
 * Auditing is the caller's job — routes call `audit()` in the same
 * transaction (staff actor); #123's poller marks `needs_reauth` as a
 * system actor. These helpers accept a `Db | Tx` so they can participate.
 *
 * NEVER-LOG(credentials): `encrypted_credentials` values returned by these
 * helpers must never appear in logs, audit payloads, or API responses.
 */

import type { SourceConnectionKind } from "@wellregarded/core";
import { and, eq, ne } from "drizzle-orm";

import type { Tx } from "../audit.js";
import type { Db } from "../client.js";
import { sourceConnections } from "../schema/sourceConnections.js";

export type SourceConnection = typeof sourceConnections.$inferSelect;

/** The one row for (practice, kind), whatever its status. */
export async function getSourceConnection(
  db: Db | Tx,
  practiceId: string,
  kind: SourceConnectionKind,
): Promise<SourceConnection | null> {
  const [row] = await db
    .select()
    .from(sourceConnections)
    .where(
      and(
        eq(sourceConnections.practiceId, practiceId),
        eq(sourceConnections.kind, kind),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface UpsertSourceConnectionInput {
  practiceId: string;
  kind: SourceConnectionKind;
  /** AES-GCM ciphertext from `encryptField` — never plaintext. */
  encryptedCredentials: string;
  scopes: string[];
  connectedBy: string;
}

/**
 * Connect or re-auth: insert the row, or — when one exists for
 * (practice, kind) in any status — replace credentials/scopes/connector and
 * restore `active`. `metadata` and `last_sync_at` are deliberately not in
 * the update list.
 */
export async function upsertSourceConnection(
  db: Db | Tx,
  input: UpsertSourceConnectionInput,
): Promise<SourceConnection> {
  const [row] = await db
    .insert(sourceConnections)
    .values({
      practiceId: input.practiceId,
      kind: input.kind,
      status: "active",
      encryptedCredentials: input.encryptedCredentials,
      scopes: input.scopes,
      connectedBy: input.connectedBy,
    })
    .onConflictDoUpdate({
      target: [sourceConnections.practiceId, sourceConnections.kind],
      set: {
        status: "active",
        encryptedCredentials: input.encryptedCredentials,
        scopes: input.scopes,
        connectedBy: input.connectedBy,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("source_connections upsert returned no row");
  return row;
}

/**
 * Refresh rejected with `invalid_grant` → `needs_reauth`. Only transitions
 * from `active`; idempotent otherwise (returns the updated row, or null
 * when nothing transitioned). Credentials stay in place: the row is not
 * disconnected, and re-auth overwrites them anyway.
 */
export async function markSourceConnectionNeedsReauth(
  db: Db | Tx,
  connectionId: string,
): Promise<SourceConnection | null> {
  const [row] = await db
    .update(sourceConnections)
    .set({ status: "needs_reauth", updatedAt: new Date() })
    .where(
      and(
        eq(sourceConnections.id, connectionId),
        eq(sourceConnections.status, "active"),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Disconnect: `status = 'disconnected'` AND credentials erased in the same
 * UPDATE. Returns null when no row exists or it is already disconnected
 * (idempotence is the caller's policy call).
 */
export async function disconnectSourceConnection(
  db: Db | Tx,
  practiceId: string,
  kind: SourceConnectionKind,
): Promise<SourceConnection | null> {
  const [row] = await db
    .update(sourceConnections)
    .set({
      status: "disconnected",
      encryptedCredentials: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sourceConnections.practiceId, practiceId),
        eq(sourceConnections.kind, kind),
        ne(sourceConnections.status, "disconnected"),
      ),
    )
    .returning();
  return row ?? null;
}
