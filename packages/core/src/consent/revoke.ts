/**
 * Pure consent revocation + the purge contract (issue #84, Epic #12).
 *
 * A revocation is a **new version row**, never an UPDATE: it carries the
 * revoker's `source`, so the precedence rule in `governingConsent` applies
 * to revocations exactly as it does to grants. That is what makes "patient
 * always wins" hold in both directions:
 *
 * - practice attests, patient revokes → the `patient_link` revocation row
 *   governs every later staff attestation, forever (until the patient
 *   themselves re-grants);
 * - patient grants, practice "revokes" via the attestation path → the
 *   `practice_attested` revocation row is recorded as history but the
 *   patient's grant still governs.
 *
 * Both the staff- and patient-initiated revocation paths share this
 * function, so the affected proof/placement ids — what the caller must
 * purge/deactivate — are computed in exactly one place. The purge cascade
 * itself is issue #91; the id computation lives here.
 */

import { z } from "zod";

import { governingConsent } from "./check.js";
import {
  type ConsentRow,
  type ConsentVersionInsert,
  type IdentifiedConsentRow,
  nextConsentVersion,
} from "./model.js";

export const revokeConsentInputSchema = z.object({
  /**
   * Who is revoking — the actor reference. `imported_unknown` is not a
   * valid revoker: a revocation is an explicit decision by a patient
   * (`patient_link`) or by staff (`practice_attested`).
   */
  source: z.enum(["patient_link", "practice_attested"]),
  revokedAt: z.date(),
  /**
   * The revoking patient, when known and not already on the grant being
   * revoked (e.g. a patient revoking a practice attestation recorded
   * before their patient record existed).
   */
  patientId: z.uuid().nullish(),
});

export type RevokeConsentInput = z.input<typeof revokeConsentInputSchema>;

/**
 * The purge contract (shared with issue #96's `proofs` table): the fields
 * of a proof row that revocation impact is computed from. Structural — the
 * Drizzle row will be assignable to it.
 */
export interface RevocationProofRef {
  id: string;
  signalId: string;
}

/**
 * The purge contract (shared with issue #96's `placements` table): the
 * fields of a placement row that revocation impact is computed from.
 * Callers pass the currently *active* placements; a placement is affected
 * when its proof is.
 */
export interface RevocationPlacementRef {
  id: string;
  proofId: string;
}

export interface ConsentRevocation {
  /**
   * The new revocation version row to insert, or `undefined` when there is
   * nothing to revoke (no consent recorded for this revoker to act on, or
   * the targeted grant is already revoked). Note an *ineffective*
   * revocation (staff revoking under a governing patient grant) still
   * produces a row — append-only history records the attempt — with
   * `effective: false` and nothing to purge.
   */
  revocation: ConsentVersionInsert | undefined;
  /**
   * Whether the revocation row becomes the governing row — i.e. whether it
   * actually changes what `checkConsent` answers. A `practice_attested`
   * revocation under a governing `patient_link` grant is recorded but not
   * effective: the patient's decision stands.
   */
  effective: boolean;
  /**
   * Proofs the caller must purge: every proof derived from the revoked
   * signal. Empty when the revocation is not effective. The purge cascade
   * (issue #91) deactivates/deletes these; recomputing publishability at
   * read time still goes through `checkConsent` — these ids exist so
   * caches and placements are cleaned up promptly, not to gate anything.
   */
  affectedProofIds: string[];
  /** Placements of the affected proofs — deactivate with `consent_revoked`. */
  affectedPlacementIds: string[];
}

/**
 * Produce a revocation version row for a signal, plus the proof/placement
 * ids the caller must purge. Pure: `consentRows` are the signal's existing
 * consent rows; `currentProofs`/`currentPlacements` are the signal's
 * proofs and their active placements (pass what exists — issue #96's
 * tables; empty arrays before they land).
 *
 * Which grant a revocation targets follows the precedence rule:
 * - `patient_link` revokes the governing row, whatever its source — a
 *   patient may take back anything;
 * - `practice_attested` revokes only the latest staff-side row
 *   (`practice_attested` / `imported_unknown`) — staff can never touch a
 *   patient's decision.
 *
 * Returns `revocation: undefined` when that target does not exist or is
 * already revoked (revocation is idempotent — nothing to record).
 *
 * Throws `ZodError` when the input does not validate.
 */
export function revokeConsent<T extends IdentifiedConsentRow>(
  input: RevokeConsentInput,
  consentRows: readonly T[],
  currentProofs: readonly RevocationProofRef[] = [],
  currentPlacements: readonly RevocationPlacementRef[] = [],
): ConsentRevocation {
  const parsed = revokeConsentInputSchema.parse(input);

  const target =
    parsed.source === "patient_link"
      ? governingConsent(consentRows)
      : governingConsent(
          consentRows.filter((row) => row.source !== "patient_link"),
        );

  if (target === undefined || target.revokedAt !== null) {
    return {
      revocation: undefined,
      effective: false,
      affectedProofIds: [],
      affectedPlacementIds: [],
    };
  }

  // The revocation row copies the scope of the grant it revokes — history
  // reads "this is what was taken back" — with the revoker's own source
  // and actor, stamped revoked from the moment it exists.
  const revocation: ConsentVersionInsert = {
    practiceId: target.practiceId,
    signalId: target.signalId,
    patientId: parsed.patientId ?? target.patientId,
    channels: [...target.channels],
    attribution: target.attribution,
    allowMinorEdits: target.allowMinorEdits,
    grantedAt: parsed.revokedAt,
    source: parsed.source,
    consentVersion: nextConsentVersion(consentRows),
    revokedAt: parsed.revokedAt,
    expiresAt: null,
  };

  const rowsAfter: readonly ConsentRow[] = [...consentRows, revocation];
  const effective = governingConsent(rowsAfter) === revocation;

  if (!effective) {
    return {
      revocation,
      effective,
      affectedProofIds: [],
      affectedPlacementIds: [],
    };
  }

  const affectedProofIds = currentProofs
    .filter((proof) => proof.signalId === target.signalId)
    .map((proof) => proof.id);
  const affected = new Set(affectedProofIds);
  const affectedPlacementIds = currentPlacements
    .filter((placement) => affected.has(placement.proofId))
    .map((placement) => placement.id);

  return { revocation, effective, affectedProofIds, affectedPlacementIds };
}
