import { describe, expect, it } from "vitest";

import {
  type ConsentChannel,
  type ConsentRow,
  checkConsent,
  describeConsentState,
  evaluateConsent,
  governingConsent,
} from "./index.js";

/** Fixture consent row; override the fields a case cares about. */
function row(overrides: Partial<ConsentRow> = {}): ConsentRow {
  return {
    channels: ["website"],
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

const NOW = new Date("2026-06-01T00:00:00Z");
const ALL_CHANNELS: ConsentChannel[] = ["website", "gbp", "email", "in_office"];

describe("governingConsent", () => {
  it("returns undefined for no rows", () => {
    expect(governingConsent([])).toBeUndefined();
  });

  it("takes the highest version within a single source", () => {
    const v1 = row({ consentVersion: 1 });
    const v2 = row({ consentVersion: 2 });
    expect(governingConsent([v1, v2])).toBe(v2);
    expect(governingConsent([v2, v1])).toBe(v2);
  });

  it("patient_link always beats practice_attested — even at a lower version", () => {
    const patient = row({ source: "patient_link", consentVersion: 1 });
    const practice = row({ source: "practice_attested", consentVersion: 5 });
    expect(governingConsent([patient, practice])).toBe(patient);
  });

  it("patient_link beats imported_unknown too", () => {
    const patient = row({ source: "patient_link", consentVersion: 1 });
    const imported = row({ source: "imported_unknown", consentVersion: 3 });
    expect(governingConsent([imported, patient])).toBe(patient);
  });

  it("without patient rows, staff-side sources resolve by version", () => {
    const imported = row({ source: "imported_unknown", consentVersion: 1 });
    const practice = row({ source: "practice_attested", consentVersion: 2 });
    expect(governingConsent([imported, practice])).toBe(practice);
  });
});

describe("checkConsent", () => {
  it("empty rows → { allowed: false, reason: 'no_consent' }", () => {
    const check = checkConsent([], "website", NOW);
    expect(check).toEqual({ allowed: false, reason: "no_consent" });
  });

  it("allowed on a granted channel, carrying the governing row", () => {
    const granted = row({ channels: ["website", "gbp"] });
    const check = checkConsent([granted], "gbp", NOW);
    expect(check).toEqual({ allowed: true, consent: granted });
  });

  it("channel-subset grant: website granted → gbp is channel_not_granted", () => {
    const granted = row({ channels: ["website"] });
    const check = checkConsent([granted], "gbp", NOW);
    expect(check).toEqual({
      allowed: false,
      reason: "channel_not_granted",
      consent: granted,
    });
  });

  it("re-grant after revoke: the new grant version supersedes the revocation", () => {
    const v1 = row({ consentVersion: 1 });
    const v2 = row({
      consentVersion: 2,
      revokedAt: new Date("2026-03-01T00:00:00Z"),
    });
    const v3 = row({ consentVersion: 3 });
    const check = checkConsent([v2, v3, v1], "website", NOW);
    expect(check).toEqual({ allowed: true, consent: v3 });
  });

  it("expired grant then renewed with a later version → allowed", () => {
    const expired = row({
      consentVersion: 1,
      expiresAt: new Date("2026-04-01T00:00:00Z"),
    });
    const renewed = row({ consentVersion: 2, expiresAt: null });
    const check = checkConsent([expired, renewed], "website", NOW);
    expect(check).toEqual({ allowed: true, consent: renewed });
  });

  it("practice attests, patient later revokes → false on every channel", () => {
    const attested = row({
      source: "practice_attested",
      channels: ALL_CHANNELS,
      consentVersion: 1,
    });
    const patientRevocation = row({
      source: "patient_link",
      channels: ALL_CHANNELS,
      consentVersion: 2,
      revokedAt: new Date("2026-05-01T00:00:00Z"),
    });
    for (const channel of ALL_CHANNELS) {
      const check = checkConsent([attested, patientRevocation], channel, NOW);
      expect(check).toEqual({
        allowed: false,
        reason: "revoked",
        consent: patientRevocation,
      });
    }
  });

  it("patient grants, practice later 'revokes' via attestation path → patient grant still governs", () => {
    const patientGrant = row({
      source: "patient_link",
      channels: ["website"],
      consentVersion: 1,
    });
    const practiceRevocation = row({
      source: "practice_attested",
      channels: ["website"],
      consentVersion: 2,
      revokedAt: new Date("2026-05-01T00:00:00Z"),
    });
    const check = checkConsent(
      [patientGrant, practiceRevocation],
      "website",
      NOW,
    );
    expect(check).toEqual({ allowed: true, consent: patientGrant });
  });

  it("staff attestation after a patient revocation cannot re-enable publication", () => {
    const patientRevocation = row({
      source: "patient_link",
      consentVersion: 2,
      revokedAt: new Date("2026-04-01T00:00:00Z"),
    });
    const laterAttestation = row({
      source: "practice_attested",
      channels: ALL_CHANNELS,
      consentVersion: 3,
    });
    const check = checkConsent(
      [row({ consentVersion: 1 }), patientRevocation, laterAttestation],
      "website",
      NOW,
    );
    expect(check).toEqual({
      allowed: false,
      reason: "revoked",
      consent: patientRevocation,
    });
  });

  it("consent_version chains: grant → narrow → revoke → re-grant resolves each step", () => {
    const v1 = row({ channels: ["website", "gbp"], consentVersion: 1 });
    const v2 = row({ channels: ["website"], consentVersion: 2 });
    const v3 = row({
      channels: ["website"],
      consentVersion: 3,
      revokedAt: new Date("2026-03-01T00:00:00Z"),
    });
    const v4 = row({ channels: ["gbp"], consentVersion: 4 });

    expect(checkConsent([v1], "gbp", NOW).allowed).toBe(true);
    expect(checkConsent([v1, v2], "gbp", NOW)).toMatchObject({
      allowed: false,
      reason: "channel_not_granted",
    });
    expect(checkConsent([v1, v2, v3], "website", NOW)).toMatchObject({
      allowed: false,
      reason: "revoked",
    });
    const final = checkConsent([v1, v2, v3, v4], "gbp", NOW);
    expect(final).toEqual({ allowed: true, consent: v4 });
    expect(checkConsent([v1, v2, v3, v4], "website", NOW)).toMatchObject({
      allowed: false,
      reason: "channel_not_granted",
    });
  });

  it("revoked reports before channel_not_granted — the 'no' is the headline", () => {
    const revoked = row({
      channels: [],
      revokedAt: new Date("2026-03-01T00:00:00Z"),
    });
    const check = checkConsent([revoked], "website", NOW);
    expect(check).toMatchObject({ allowed: false, reason: "revoked" });
  });

  it("expiry boundary: at exactly equal to expires_at → expired (exclusive)", () => {
    const expiring = row({ expiresAt: NOW });
    const check = checkConsent([expiring], "website", NOW);
    expect(check).toEqual({
      allowed: false,
      reason: "expired",
      consent: expiring,
    });
  });

  it("point-in-time: a grant expired now was still allowed at an earlier `at`", () => {
    const grant = row({ expiresAt: new Date("2026-05-01T00:00:00Z") });
    expect(checkConsent([grant], "website", NOW)).toMatchObject({
      allowed: false,
      reason: "expired",
    });
    const earlier = checkConsent(
      [grant],
      "website",
      new Date("2026-04-01T00:00:00Z"),
    );
    expect(earlier).toEqual({ allowed: true, consent: grant });
  });

  it("`at` defaults to now", () => {
    const active = row({ expiresAt: new Date("9999-01-01T00:00:00Z") });
    expect(checkConsent([active], "website")).toEqual({
      allowed: true,
      consent: active,
    });
    const expired = row({ expiresAt: new Date("2000-01-01T00:00:00Z") });
    expect(checkConsent([expired], "website")).toMatchObject({
      allowed: false,
      reason: "expired",
    });
  });
});

describe("evaluateConsent", () => {
  it("returns no_consent (and no winning row) when there are no rows", () => {
    const decision = evaluateConsent([], "website", NOW);
    expect(decision).toEqual({ publishable: false, reason: "no_consent" });
    expect(decision.consent).toBeUndefined();
  });

  it("is publishable when the channel is granted and the row is active", () => {
    const granted = row({ channels: ["website", "gbp"] });
    const decision = evaluateConsent([granted], "gbp", NOW);
    expect(decision.publishable).toBe(true);
    expect(decision.reason).toBe("ok");
    expect(decision.consent).toBe(granted);
  });

  it("reports channel_not_granted when the channel is missing, with the governing row attached", () => {
    const granted = row({ channels: ["website"] });
    const decision = evaluateConsent([granted], "email", NOW);
    expect(decision).toMatchObject({
      publishable: false,
      reason: "channel_not_granted",
    });
    expect(decision.consent).toBe(granted);
  });

  it("reports revoked when the current row has revoked_at set", () => {
    const revoked = row({ revokedAt: new Date("2026-03-01T00:00:00Z") });
    const decision = evaluateConsent([revoked], "website", NOW);
    expect(decision).toMatchObject({ publishable: false, reason: "revoked" });
    expect(decision.consent).toBe(revoked);
  });

  it("reports expired when expires_at is in the past", () => {
    const expired = row({ expiresAt: new Date("2026-05-31T23:59:59Z") });
    const decision = evaluateConsent([expired], "website", NOW);
    expect(decision).toMatchObject({ publishable: false, reason: "expired" });
    expect(decision.consent).toBe(expired);
  });

  it("treats expires_at exactly at now as expired (expiry is exclusive)", () => {
    const decision = evaluateConsent([row({ expiresAt: NOW })], "website", NOW);
    expect(decision.reason).toBe("expired");
  });

  it("stays publishable when expires_at is in the future", () => {
    const decision = evaluateConsent(
      [row({ expiresAt: new Date("2027-01-01T00:00:00Z") })],
      "website",
      NOW,
    );
    expect(decision).toMatchObject({ publishable: true, reason: "ok" });
  });

  it("only consults the governing version: v2 narrowing channels removes gbp", () => {
    const v1 = row({ channels: ["website", "gbp"], consentVersion: 1 });
    const v2 = row({ channels: ["website"], consentVersion: 2 });

    // v1 granted gbp, but v2 is current and only grants website.
    const gbp = evaluateConsent([v1, v2], "gbp", NOW);
    expect(gbp).toMatchObject({
      publishable: false,
      reason: "channel_not_granted",
    });
    expect(gbp.consent).toBe(v2);

    const website = evaluateConsent([v1, v2], "website", NOW);
    expect(website).toMatchObject({ publishable: true, reason: "ok" });
  });

  it("re-grant after revocation: v2 revoked, v3 active → publishable", () => {
    const v1 = row({ consentVersion: 1 });
    const v2 = row({
      consentVersion: 2,
      revokedAt: new Date("2026-04-01T00:00:00Z"),
    });
    const v3 = row({ consentVersion: 3 });
    const decision = evaluateConsent([v3, v1, v2], "website", NOW);
    expect(decision).toMatchObject({ publishable: true, reason: "ok" });
    expect(decision.consent).toBe(v3);
  });

  it("revocation on the highest version wins even when older versions are active", () => {
    const v1 = row({ consentVersion: 1 });
    const v2 = row({
      consentVersion: 2,
      revokedAt: new Date("2026-04-01T00:00:00Z"),
    });
    const decision = evaluateConsent([v1, v2], "website", NOW);
    expect(decision).toMatchObject({ publishable: false, reason: "revoked" });
    expect(decision.consent).toBe(v2);
  });

  it("row order does not matter — the governing row wins regardless", () => {
    const v1 = row({ channels: ["gbp"], consentVersion: 1 });
    const v2 = row({ channels: ["website"], consentVersion: 2 });
    for (const rows of [
      [v1, v2],
      [v2, v1],
    ]) {
      const decision = evaluateConsent(rows, "website", NOW);
      expect(decision.reason).toBe("ok");
      expect(decision.consent).toBe(v2);
    }
  });

  it("agrees with checkConsent on the precedence rule", () => {
    const patientGrant = row({ source: "patient_link", consentVersion: 1 });
    const practiceRevocation = row({
      source: "practice_attested",
      consentVersion: 2,
      revokedAt: new Date("2026-05-01T00:00:00Z"),
    });
    const decision = evaluateConsent(
      [patientGrant, practiceRevocation],
      "website",
      NOW,
    );
    expect(decision).toMatchObject({ publishable: true, reason: "ok" });
    expect(decision.consent).toBe(patientGrant);
  });

  it("covers every channel value without widening the type", () => {
    const all = row({ channels: ALL_CHANNELS });
    for (const channel of ALL_CHANNELS) {
      expect(evaluateConsent([all], channel, NOW).publishable).toBe(true);
    }
  });
});

describe("describeConsentState", () => {
  it("states the honest default when no rows exist — never default-open", () => {
    const state = describeConsentState([], NOW);
    expect(state).toEqual({
      publishable: false,
      status: "none",
      summary: "No consent recorded — not publishable",
    });
    expect(state.consent).toBeUndefined();
  });

  it("summarizes an active grant's channels, publishable", () => {
    const granted = row({ channels: ["website"] });
    const state = describeConsentState([granted], NOW);
    expect(state.publishable).toBe(true);
    expect(state.status).toBe("granted");
    expect(state.summary).toBe("Website permission granted");
    expect(state.consent).toBe(granted);
  });

  it("labels multiple channels in grant order", () => {
    const granted = row({ channels: ["gbp", "in_office"] });
    const state = describeConsentState([granted], NOW);
    expect(state.summary).toBe("Google profile + In office permission granted");
  });

  it("reports revoked with its reason", () => {
    const revoked = row({ revokedAt: new Date("2026-03-01T00:00:00Z") });
    const state = describeConsentState([revoked], NOW);
    expect(state).toMatchObject({
      publishable: false,
      status: "revoked",
      summary: "Consent revoked — not publishable",
    });
    expect(state.consent).toBe(revoked);
  });

  it("reports expired with its reason", () => {
    const expired = row({ expiresAt: new Date("2026-05-31T23:59:59Z") });
    const state = describeConsentState([expired], NOW);
    expect(state).toMatchObject({
      publishable: false,
      status: "expired",
      summary: "Consent expired — not publishable",
    });
  });

  it("a grant expiring in the future is still active", () => {
    const state = describeConsentState(
      [row({ expiresAt: new Date("2026-06-02T00:00:00Z") })],
      NOW,
    );
    expect(state.publishable).toBe(true);
    expect(state.status).toBe("granted");
  });

  it("only the governing version is consulted — a narrowing supersedes", () => {
    const v1 = row({ channels: ["website", "gbp"], consentVersion: 1 });
    const v2 = row({ channels: ["email"], consentVersion: 2 });
    const state = describeConsentState([v1, v2], NOW);
    expect(state.summary).toBe("Email permission granted");
    expect(state.consent).toBe(v2);
  });

  it("shows the patient's decision when staff attested later — patient wins", () => {
    const patientRevocation = row({
      source: "patient_link",
      consentVersion: 1,
      revokedAt: new Date("2026-03-01T00:00:00Z"),
    });
    const laterAttestation = row({
      source: "practice_attested",
      consentVersion: 2,
    });
    const state = describeConsentState(
      [patientRevocation, laterAttestation],
      NOW,
    );
    expect(state).toMatchObject({ publishable: false, status: "revoked" });
    expect(state.consent).toBe(patientRevocation);
  });

  it("an empty channels array is honest: granted but not publishable", () => {
    const state = describeConsentState([row({ channels: [] })], NOW);
    expect(state).toMatchObject({
      publishable: false,
      status: "granted",
      summary: "No channels granted — not publishable",
    });
  });
});
