import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  checkConsent,
  type IdentifiedConsentRow,
  type RevocationPlacementRef,
  type RevocationProofRef,
  revokeConsent,
} from "./index.js";

const PRACTICE_ID = "0b2f8a2e-4d3c-4b6a-9f21-6a1d2c3e4f50";
const SIGNAL_ID = "1c3e9b3f-5e4d-4c7b-8a32-7b2e3d4f5a61";
const OTHER_SIGNAL_ID = "3e5a1d51-7a6f-4e9d-8c54-9d4a5f6b7c83";
const PATIENT_ID = "2d4f0c40-6f5e-4d8c-9b43-8c3f4e5a6b72";

const REVOKED_AT = new Date("2026-06-01T00:00:00Z");

/** Fixture consent row; override the fields a case cares about. */
function row(
  overrides: Partial<IdentifiedConsentRow> = {},
): IdentifiedConsentRow {
  return {
    practiceId: PRACTICE_ID,
    signalId: SIGNAL_ID,
    patientId: PATIENT_ID,
    channels: ["website", "gbp"],
    attribution: "first_name",
    allowMinorEdits: false,
    grantedAt: new Date("2026-01-01T00:00:00Z"),
    source: "patient_link",
    consentVersion: 1,
    revokedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

const PROOFS: RevocationProofRef[] = [
  { id: "proof-1", signalId: SIGNAL_ID },
  { id: "proof-2", signalId: SIGNAL_ID },
  { id: "proof-other", signalId: OTHER_SIGNAL_ID },
];

const PLACEMENTS: RevocationPlacementRef[] = [
  { id: "placement-1", proofId: "proof-1" },
  { id: "placement-2", proofId: "proof-2" },
  { id: "placement-3", proofId: "proof-2" },
  { id: "placement-other", proofId: "proof-other" },
];

describe("revokeConsent (pure)", () => {
  it("patient revocation produces an effective revocation row over a patient grant", () => {
    const grant = row();
    const result = revokeConsent(
      { source: "patient_link", revokedAt: REVOKED_AT },
      [grant],
      PROOFS,
      PLACEMENTS,
    );
    expect(result.effective).toBe(true);
    expect(result.revocation).toEqual({
      practiceId: PRACTICE_ID,
      signalId: SIGNAL_ID,
      patientId: PATIENT_ID,
      channels: ["website", "gbp"],
      attribution: "first_name",
      allowMinorEdits: false,
      grantedAt: REVOKED_AT,
      source: "patient_link",
      consentVersion: 2,
      revokedAt: REVOKED_AT,
      expiresAt: null,
    });
  });

  it("returns the proof and placement ids to purge — only this signal's", () => {
    const result = revokeConsent(
      { source: "patient_link", revokedAt: REVOKED_AT },
      [row()],
      PROOFS,
      PLACEMENTS,
    );
    expect(result.affectedProofIds).toEqual(["proof-1", "proof-2"]);
    expect(result.affectedPlacementIds).toEqual([
      "placement-1",
      "placement-2",
      "placement-3",
    ]);
  });

  it("defaults proofs/placements to empty — the tables land with issue #96", () => {
    const result = revokeConsent(
      { source: "patient_link", revokedAt: REVOKED_AT },
      [row()],
    );
    expect(result.effective).toBe(true);
    expect(result.affectedProofIds).toEqual([]);
    expect(result.affectedPlacementIds).toEqual([]);
  });

  it("practice attests, patient revokes → effective, and the row is patient_link", () => {
    const attested = row({ source: "practice_attested", patientId: null });
    const result = revokeConsent(
      { source: "patient_link", revokedAt: REVOKED_AT, patientId: PATIENT_ID },
      [attested],
      PROOFS,
      PLACEMENTS,
    );
    expect(result.effective).toBe(true);
    expect(result.revocation).toMatchObject({
      source: "patient_link",
      patientId: PATIENT_ID,
      consentVersion: 2,
      revokedAt: REVOKED_AT,
    });
    expect(result.affectedProofIds).toEqual(["proof-1", "proof-2"]);
    // And the check agrees: false everywhere, and a later staff attestation
    // cannot re-enable it (the patient_link revocation row governs).
    const rows = [attested, { ...(result.revocation as IdentifiedConsentRow) }];
    expect(checkConsent(rows, "website")).toMatchObject({
      allowed: false,
      reason: "revoked",
    });
  });

  it("patient grants, practice 'revokes' via attestation path → recorded but not effective, nothing to purge", () => {
    const patientGrant = row();
    const result = revokeConsent(
      { source: "practice_attested", revokedAt: REVOKED_AT },
      [patientGrant, row({ source: "practice_attested", consentVersion: 2 })],
      PROOFS,
      PLACEMENTS,
    );
    expect(result.effective).toBe(false);
    expect(result.revocation).toMatchObject({
      source: "practice_attested",
      consentVersion: 3,
      revokedAt: REVOKED_AT,
    });
    expect(result.affectedProofIds).toEqual([]);
    expect(result.affectedPlacementIds).toEqual([]);
    // The patient grant still governs.
    const rows = [
      patientGrant,
      { ...(result.revocation as IdentifiedConsentRow) },
    ];
    expect(checkConsent(rows, "website")).toEqual({
      allowed: true,
      consent: patientGrant,
    });
  });

  it("practice revocation cannot target a patient grant at all — nothing staff-side to revoke", () => {
    const result = revokeConsent(
      { source: "practice_attested", revokedAt: REVOKED_AT },
      [row()],
      PROOFS,
      PLACEMENTS,
    );
    expect(result).toEqual({
      revocation: undefined,
      effective: false,
      affectedProofIds: [],
      affectedPlacementIds: [],
    });
  });

  it("practice revocation of its own attestation (no patient rows) is effective", () => {
    const attested = row({ source: "practice_attested", patientId: null });
    const result = revokeConsent(
      { source: "practice_attested", revokedAt: REVOKED_AT },
      [attested],
      PROOFS,
      PLACEMENTS,
    );
    expect(result.effective).toBe(true);
    expect(result.revocation).toMatchObject({
      source: "practice_attested",
      consentVersion: 2,
    });
    expect(result.affectedProofIds).toEqual(["proof-1", "proof-2"]);
  });

  it("practice revocation also covers imported_unknown grants", () => {
    const imported = row({ source: "imported_unknown", patientId: null });
    const result = revokeConsent(
      { source: "practice_attested", revokedAt: REVOKED_AT },
      [imported],
    );
    expect(result.effective).toBe(true);
    expect(result.revocation).toMatchObject({
      source: "practice_attested",
      channels: ["website", "gbp"],
    });
  });

  it("nothing to revoke: no rows → no revocation row", () => {
    const result = revokeConsent(
      { source: "patient_link", revokedAt: REVOKED_AT },
      [],
      PROOFS,
      PLACEMENTS,
    );
    expect(result).toEqual({
      revocation: undefined,
      effective: false,
      affectedProofIds: [],
      affectedPlacementIds: [],
    });
  });

  it("already revoked → idempotent no-op", () => {
    const grant = row();
    const revocation = row({ consentVersion: 2, revokedAt: REVOKED_AT });
    const result = revokeConsent(
      { source: "patient_link", revokedAt: new Date("2026-07-01T00:00:00Z") },
      [grant, revocation],
      PROOFS,
      PLACEMENTS,
    );
    expect(result.revocation).toBeUndefined();
    expect(result.effective).toBe(false);
  });

  it("re-grant after revoke stays revocable — the chain keeps versioning up", () => {
    const chain = [
      row({ consentVersion: 1 }),
      row({ consentVersion: 2, revokedAt: new Date("2026-03-01T00:00:00Z") }),
      row({ consentVersion: 3 }),
    ];
    const result = revokeConsent(
      { source: "patient_link", revokedAt: REVOKED_AT },
      chain,
    );
    expect(result.effective).toBe(true);
    expect(result.revocation).toMatchObject({ consentVersion: 4 });
  });

  it("rejects imported_unknown as a revoker", () => {
    expect(() =>
      revokeConsent(
        { source: "imported_unknown" as never, revokedAt: REVOKED_AT },
        [row()],
      ),
    ).toThrow(ZodError);
  });
});
