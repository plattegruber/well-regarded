/**
 * Signal lookups and pipeline write helpers (Epic #3 table; first reader is
 * the classify stage #67, first writer the normalize stage #104).
 *
 * Pipeline messages deliberately carry only ids — every stage re-reads the
 * `signals` row so nothing stale rides in a queue message. This module is
 * that re-read, plus the normalize stage's idempotent insert path (kept in
 * `packages/db` so the worker never writes inline SQL).
 */

import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { Tx } from "../audit.js";
import type { Db } from "../client.js";
import { signals } from "../schema/signals.js";

/** A `signals` row. */
export type Signal = typeof signals.$inferSelect;

/** Fetch one signal by id; `undefined` when no such row exists. */
export async function getSignal(
  db: Db,
  signalId: string,
): Promise<Signal | undefined> {
  const rows = await db
    .select()
    .from(signals)
    .where(eq(signals.id, signalId))
    .limit(1);
  return rows[0];
}

export type SignalInsert = typeof signals.$inferInsert;

/** One outcome of `insertNormalizedSignals`, per surviving signal row. */
export interface NormalizedSignalOutcome {
  signalId: string;
  sourceId: string | null;
  /**
   * `created`: a new row was inserted. `conflict`: the insert hit the
   * `(practice_id, source_kind, source_id)` unique constraint — the signal
   * already existed (re-poll/re-import), and `signalId` is the EXISTING
   * row's id. The caller enqueues the conflict as a potential-update dedupe
   * message (`reason: "conflict_reimport"`).
   */
  outcome: "created" | "conflict";
}

/**
 * Insert normalized signals idempotently: `INSERT ... ON CONFLICT DO
 * NOTHING RETURNING id`, with the partial unique index on `(practice_id,
 * source_kind, source_id)` (Epic #3) as the backstop — a re-delivered
 * artifact can never duplicate rows. Rows with a null `sourceId` have no
 * conflict target and always insert (manual entry has no source-native
 * identity; its idempotency story is the dedupe stage's content hash, #106).
 *
 * Call inside the per-artifact transaction (#104 requirement 7) together
 * with `incrementImportRunCounts`, so rows and counts commit atomically.
 *
 * All `rows` must share one `practiceId`/`sourceKind` (one artifact = one
 * source); the conflict lookup relies on it.
 */
export async function insertNormalizedSignals(
  tx: Db | Tx,
  rows: SignalInsert[],
): Promise<NormalizedSignalOutcome[]> {
  if (rows.length === 0) return [];

  const inserted = await tx
    .insert(signals)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: signals.id, sourceId: signals.sourceId });

  const insertedBySourceId = new Map<string, string>();
  const outcomes: NormalizedSignalOutcome[] = [];
  for (const row of inserted) {
    if (row.sourceId !== null) {
      insertedBySourceId.set(row.sourceId, row.id);
    }
  }

  // Which input sourceIds conflicted? Everything sent but not returned.
  // (A duplicate sourceId WITHIN one artifact also lands here — DO NOTHING
  // applies inside a single statement too — and resolves to the row its
  // first occurrence created.)
  const conflictedSourceIds = [
    ...new Set(
      rows
        .map((row) => row.sourceId)
        .filter(
          (sourceId): sourceId is string =>
            typeof sourceId === "string" && !insertedBySourceId.has(sourceId),
        ),
    ),
  ];

  const first = rows[0];
  const existing =
    conflictedSourceIds.length > 0 && first !== undefined
      ? await tx
          .select({ id: signals.id, sourceId: signals.sourceId })
          .from(signals)
          .where(
            and(
              eq(signals.practiceId, first.practiceId),
              eq(signals.sourceKind, first.sourceKind),
              isNotNull(signals.sourceId),
              inArray(signals.sourceId, conflictedSourceIds),
            ),
          )
      : [];

  // Every inserted row (null-sourceId rows included) is a creation.
  for (const row of inserted) {
    outcomes.push({
      signalId: row.id,
      sourceId: row.sourceId,
      outcome: "created",
    });
  }
  for (const row of existing) {
    outcomes.push({
      signalId: row.id,
      sourceId: row.sourceId,
      outcome: "conflict",
    });
  }
  return outcomes;
}
