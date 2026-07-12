/**
 * Drizzle-backed `GbpSyncStore` (issue #123) — the durable half of the
 * sync engine, kept behind the structural interface so unit tests fake it
 * and integration tests drive THIS implementation against real Postgres.
 *
 * Also home of `persistNeedsReauth`, the `onInvalidGrant` hook for the
 * #118 token provider: status flip + system-actor audit row in one
 * transaction, so the connection is durably `needs_reauth` (and auditable)
 * even if the caller mishandles the thrown `NeedsReauthError`. The settings
 * card (#118) and the Today screen (Epic #11) both read
 * `source_connections.status` — flipping it IS the user-facing surfacing.
 */

import {
  appendImportRunError,
  audit,
  createImportRun,
  type Db,
  finalizeImportRunWithStatus,
  getSourceConnectionById,
  incrementImportRunCounts,
  markSourceConnectionNeedsReauth,
  patchSourceConnectionMetadata,
  setImportRunArtifactKeys,
  setSourceConnectionLastSyncAt,
} from "@wellregarded/db";

import type { GbpSyncStore } from "./gbpSync";

/** `audit_log.actor_id` for poller-initiated mutations (system actor). */
export const GBP_SYNC_ACTOR_ID = "jobs:gbp-sync";

/**
 * Flip an active connection to `needs_reauth` and audit the transition as
 * a system action, atomically. Idempotent: `markSourceConnectionNeedsReauth`
 * only transitions from `active`, so a second `invalid_grant` (or a stale
 * poller racing a disconnect) writes neither row.
 */
export async function persistNeedsReauth(
  db: Db,
  connectionId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await markSourceConnectionNeedsReauth(tx, connectionId);
    if (row === null) return;
    await audit(tx, {
      practiceId: row.practiceId,
      actor: { type: "system", id: GBP_SYNC_ACTOR_ID },
      action: "source_connection.needs_reauth",
      entityType: "source_connections",
      entityId: row.id,
      // References only, never credentials: the reason is the OAuth error
      // code, which is public vocabulary.
      payload: { kind: row.kind, reason: "invalid_grant" },
    });
  });
}

/** The real store: thin adapters over the packages/db helpers. */
export function createGbpSyncStore(db: Db): GbpSyncStore {
  return {
    getConnection: (connectionId) => getSourceConnectionById(db, connectionId),
    createImportRun: (input) =>
      createImportRun(db, {
        practiceId: input.practiceId,
        sourceKind: "google",
        trigger: input.trigger,
      }),
    recordRunError: (importRunId, sample) =>
      appendImportRunError(db, importRunId, {
        ...sample,
        occurredAt: new Date().toISOString(),
      }),
    accumulateRunStats: (importRunId, stats) =>
      incrementImportRunCounts(db, importRunId, {}, stats),
    finalizeRun: async (importRunId, status) => {
      await finalizeImportRunWithStatus(db, importRunId, status);
    },
    recordRunArtifactKeys: (importRunId, keys) =>
      setImportRunArtifactKeys(db, importRunId, keys),
    saveSyncCursors: async (connectionId, cursors) => {
      // Per-key patch: #121's snapshot/mappings live in the same jsonb and
      // must round-trip untouched (see patchSourceConnectionMetadata).
      await patchSourceConnectionMetadata(db, connectionId, {
        syncCursors: cursors,
      });
    },
    setLastSyncAt: (connectionId) =>
      setSourceConnectionLastSyncAt(db, connectionId),
  };
}
