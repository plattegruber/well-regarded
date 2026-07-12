import { describe, expect, it } from "vitest";

import {
  type ConsentChannel,
  type ConsentRow,
  describeConsentState,
  evaluateConsent,
} from "./consent";

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

  it("reports channel_not_granted when the channel is missing, with the winning row attached", () => {
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

  it("only consults the highest version: v2 narrowing channels removes gbp", () => {
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

  it("row order does not matter — highest consent_version wins regardless", () => {
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

  it("covers every channel value without widening the type", () => {
    const all = row({ channels: ["website", "gbp", "email", "in_office"] });
    const channels: ConsentChannel[] = ["website", "gbp", "email", "in_office"];
    for (const channel of channels) {
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

  it("only the highest version is consulted — a narrowing supersedes", () => {
    const v1 = row({ channels: ["website", "gbp"], consentVersion: 1 });
    const v2 = row({ channels: ["email"], consentVersion: 2 });
    const state = describeConsentState([v1, v2], NOW);
    expect(state.summary).toBe("Email permission granted");
    expect(state.consent).toBe(v2);
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
