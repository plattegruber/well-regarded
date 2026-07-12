/**
 * Consent queries — the publication gate (issues #38 and #84, Epics #3 and
 * #12).
 *
 * `isPublishable` below is THE single entry point for publication
 * eligibility. Any publication path (Proof API in Epic #14, proof library in
 * Epic #13, review responses in Epic #10, GBP placement) that does not call
 * it is a bug. There is no `is_publishable` boolean anywhere — eligibility
 * is computed at read time from append-only `consents` rows. See
 * packages/db/CONSENT.md and the "Publication checks" section of
 * CONTRIBUTING.md.
 *
 * These wrappers are thin on purpose: every decision and every row shape is
 * produced by the pure functions in `@wellregarded/core` (`checkConsent`,
 * `grantConsent`, `revokeConsent` in `src/consent/`); this module only adds
 * the fetch and the transaction.
 */

import {
  grantConsent as buildConsentGrant,
  revokeConsent as buildConsentRevocation,
  type ConsentChannel,
  type ConsentDecision,
  evaluateConsent,
  type GrantConsentInput,
  type RevocationPlacementRef,
  type RevocationProofRef,
  type RevokeConsentInput,
} from "@wellregarded/core";
import { eq, sql } from "drizzle-orm";

import type { Tx } from "../audit.js";
import type { Db } from "../client.js";
import { consents } from "../schema/consents.js";
import { purgeTargetsForSignal } from "./proofs.js";

export type { GrantConsentInput, RevokeConsentInput };

/** A `consents` row (assignable to core's `IdentifiedConsentRow`). */
export type Consent = typeof consents.$inferSelect;

/**
 * Can `signalId` be published on `channel` right now?
 *
 * **The single publication gate.** Every publication path MUST call this —
 * a path that checks anything else (or caches the answer in a flag) is a
 * bug. Fetches the signal's consent rows and delegates the decision to the
 * pure `checkConsent` logic in `@wellregarded/core` (via its
 * `ConsentDecision`-shaped wrapper `evaluateConsent`); the returned decision
 * carries the governing consent row so callers can apply attribution and
 * minor-edit rules, and a `reason` so UIs can explain a refusal.
 */
export async function isPublishable(
  db: Db,
  signalId: string,
  channel: ConsentChannel,
): Promise<ConsentDecision<Consent>> {
  const rows = await db
    .select()
    .from(consents)
    .where(eq(consents.signalId, signalId));
  return evaluateConsent(rows, channel, new Date());
}

/**
 * Record a consent grant (or narrowing, or re-grant after revocation) as a
 * new versioned row. The row values — defaults, validation, and the
 * `consent_version = max + 1` math — come from the pure `grantConsent`
 * builder in `@wellregarded/core`; the current max is read inside the same
 * transaction as the insert, so callers never hand-roll version math.
 * Concurrent grants for the same signal surface as a unique violation on
 * `(signal_id, consent_version)` (Postgres error 23505): retryable, never
 * silently mis-versioned.
 *
 * Accepts a transaction handle too (issue #138: the normalize stage's
 * consent seam grants inside its per-artifact transaction); the inner
 * `transaction` then runs as a savepoint within the caller's.
 */
export async function grantConsent(
  db: Db | Tx,
  input: GrantConsentInput,
): Promise<Consent> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        maxVersion: sql<number>`coalesce(max(${consents.consentVersion}), 0)`,
      })
      .from(consents)
      .where(eq(consents.signalId, input.signalId));

    const values = buildConsentGrant(input, [
      { consentVersion: current?.maxVersion ?? 0 },
    ]);
    const [row] = await tx.insert(consents).values(values).returning();
    if (!row) throw new Error("consent insert returned no row");
    return row;
  });
}

/** What `revokeConsent` hands back — the purge contract (issue #84). */
export interface RevokeConsentResult {
  /**
   * The inserted revocation version row, or `undefined` when there was
   * nothing to revoke (no consent recorded for this revoker to act on, or
   * already revoked).
   */
  revocation: Consent | undefined;
  /**
   * Whether the revocation changes what `isPublishable` answers. A
   * `practice_attested` revocation under a governing `patient_link` grant
   * is recorded but not effective — the patient's decision stands.
   */
  effective: boolean;
  /**
   * Proofs derived from this signal, which the caller must purge, and
   * their active placements, which the caller must deactivate (with
   * `deactivation_reason = 'consent_revoked'`). The purge cascade is issue
   * #91; both the staff- and patient-initiated revocation paths get the
   * ids from here so the computation exists exactly once. Empty when the
   * revocation is not effective — and empty until issue #96 lands the
   * `proofs`/`placements` tables (see `currentPurgeTargets`).
   */
  affectedProofIds: string[];
  affectedPlacementIds: string[];
}

/**
 * Revoke consent for a signal by **inserting a new revocation version row**
 * — never an UPDATE; `consents` is append-only. The row carries the
 * revoker's `source`, so the patient-always-wins precedence applies to
 * revocations exactly as to grants (a staff attestation can never override
 * a patient's revocation, and a staff revocation can never silence a
 * patient's grant). All semantics live in the pure `revokeConsent` in
 * `@wellregarded/core`; this wrapper fetches the signal's consent rows and
 * current proofs/placements, inserts the produced row, and returns the
 * purge contract.
 */
export async function revokeConsent(
  db: Db | Tx,
  params: { signalId: string } & RevokeConsentInput,
): Promise<RevokeConsentResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(consents)
      .where(eq(consents.signalId, params.signalId));
    const { proofs, placements } = await currentPurgeTargets(
      tx,
      params.signalId,
    );
    const outcome = buildConsentRevocation(params, rows, proofs, placements);
    if (outcome.revocation === undefined) {
      return {
        revocation: undefined,
        effective: false,
        affectedProofIds: [],
        affectedPlacementIds: [],
      };
    }
    const [row] = await tx
      .insert(consents)
      .values(outcome.revocation)
      .returning();
    if (!row) throw new Error("consent revocation insert returned no row");
    return {
      revocation: row,
      effective: outcome.effective,
      affectedProofIds: outcome.affectedProofIds,
      affectedPlacementIds: outcome.affectedPlacementIds,
    };
  });
}

/**
 * The signal's proofs and their active placements — what a revocation must
 * purge. Filled by issue #96 (the seam this was reserved for): the selects
 * live in ./proofs.js next to the tables; the return shape is the purge
 * contract in `@wellregarded/core` (`RevocationProofRef` /
 * `RevocationPlacementRef`).
 */
async function currentPurgeTargets(
  tx: Tx,
  signalId: string,
): Promise<{
  proofs: RevocationProofRef[];
  placements: RevocationPlacementRef[];
}> {
  return purgeTargetsForSignal(tx, signalId);
}
