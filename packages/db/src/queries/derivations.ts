/**
 * Current-derivation resolution (issue #36, Epic #3).
 *
 * The "current" derivation per (signal_id, dimension) is resolved here and
 * only here:
 *
 *   1. any `basis = 'manual'` row beats any non-manual row, regardless of
 *      recency — a human correction must never be silently overridden by a
 *      newer model run;
 *   2. among rows of equal manual-ness, latest `created_at` wins.
 *
 * Implemented as a single `DISTINCT ON` query ordered by
 * `signal_id, dimension, (basis = 'manual') DESC, created_at DESC` — the raw
 * `sql` escape hatch inside the typed builder, per the issue.
 */

import {
  DERIVATION_DIMENSIONS,
  type DerivationDimension,
} from "@wellregarded/core";
import { desc, inArray, sql } from "drizzle-orm";

import type { Db } from "../client.js";
import { derivations } from "../schema/derivations.js";

/** A `derivations` row. Exported for Epic #9 (writers) and Epic #11 (readers). */
export type Derivation = typeof derivations.$inferSelect;

/** The current derivation for each dimension; `undefined` where none exists. */
export type CurrentDerivations = Record<
  DerivationDimension,
  Derivation | undefined
>;

/**
 * The one `DISTINCT ON` query behind both helpers, exposed for unit tests
 * that assert the ordering encodes manual-outranks-inferred exactly.
 * `(basis = 'manual') DESC` sorts manual rows first (true > false); ties
 * fall through to recency.
 */
export function currentDerivationsQuery(db: Db, signalIds: readonly string[]) {
  return db
    .selectDistinctOn([derivations.signalId, derivations.dimension])
    .from(derivations)
    .where(inArray(derivations.signalId, [...signalIds]))
    .orderBy(
      derivations.signalId,
      derivations.dimension,
      sql`(${derivations.basis} = 'manual') DESC`,
      desc(derivations.createdAt),
    );
}

function emptyCurrentDerivations(): CurrentDerivations {
  return Object.fromEntries(
    DERIVATION_DIMENSIONS.map((dimension) => [dimension, undefined]),
  ) as CurrentDerivations;
}

/** The current derivation per dimension for one signal. */
export async function getCurrentDerivations(
  db: Db,
  signalId: string,
): Promise<CurrentDerivations> {
  const result = await getCurrentDerivationsForSignals(db, [signalId]);
  // getCurrentDerivationsForSignals returns an entry for every requested id.
  return result[signalId] ?? emptyCurrentDerivations();
}

/**
 * The current derivations for many signals in one query — inbox list views
 * (Epic #11) need this; per-signal calls would be an N+1. The result has an
 * entry for every requested `signalId`, even when a signal has no
 * derivations yet.
 */
export async function getCurrentDerivationsForSignals(
  db: Db,
  signalIds: readonly string[],
): Promise<Record<string, CurrentDerivations>> {
  const result: Record<string, CurrentDerivations> = {};
  for (const signalId of signalIds) {
    result[signalId] = emptyCurrentDerivations();
  }
  if (signalIds.length === 0) return result;

  const rows = await currentDerivationsQuery(db, signalIds);
  for (const row of rows) {
    const forSignal = result[row.signalId];
    if (forSignal) forSignal[row.dimension] = row;
  }
  return result;
}
