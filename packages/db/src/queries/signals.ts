/**
 * Signal lookups (Epic #3 table, first reader is the classify stage, #67).
 *
 * Pipeline messages deliberately carry only ids — every stage re-reads the
 * `signals` row so nothing stale rides in a queue message. This module is
 * that re-read.
 */

import { eq } from "drizzle-orm";

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
