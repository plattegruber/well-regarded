import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { checkConsent, type GrantConsentInput, grantConsent } from "./index.js";

const PRACTICE_ID = "0b2f8a2e-4d3c-4b6a-9f21-6a1d2c3e4f50";
const SIGNAL_ID = "1c3e9b3f-5e4d-4c7b-8a32-7b2e3d4f5a61";
const PATIENT_ID = "2d4f0c40-6f5e-4d8c-9b43-8c3f4e5a6b72";

function input(overrides: Partial<GrantConsentInput> = {}): GrantConsentInput {
  return {
    practiceId: PRACTICE_ID,
    signalId: SIGNAL_ID,
    channels: ["website"],
    attribution: "first_name",
    grantedAt: new Date("2026-05-01T00:00:00Z"),
    source: "patient_link",
    ...overrides,
  };
}

describe("grantConsent (pure)", () => {
  it("produces a version-1 row for a signal with no prior consent", () => {
    const insert = grantConsent(input());
    expect(insert).toEqual({
      practiceId: PRACTICE_ID,
      signalId: SIGNAL_ID,
      patientId: null,
      channels: ["website"],
      attribution: "first_name",
      allowMinorEdits: false,
      grantedAt: new Date("2026-05-01T00:00:00Z"),
      source: "patient_link",
      consentVersion: 1,
      revokedAt: null,
      expiresAt: null,
    });
  });

  it("increments consent_version past every existing version", () => {
    const insert = grantConsent(input(), [
      { consentVersion: 1 },
      { consentVersion: 3 },
      { consentVersion: 2 },
    ]);
    expect(insert.consentVersion).toBe(4);
  });

  it("never revokes: a grant row always starts with revoked_at null", () => {
    const insert = grantConsent(
      input({ expiresAt: new Date("2027-01-01T00:00:00Z") }),
      [{ consentVersion: 7 }],
    );
    expect(insert.revokedAt).toBeNull();
    expect(insert.expiresAt).toEqual(new Date("2027-01-01T00:00:00Z"));
  });

  it("carries the optional fields through: patientId, allowMinorEdits", () => {
    const insert = grantConsent(
      input({ patientId: PATIENT_ID, allowMinorEdits: true }),
    );
    expect(insert.patientId).toBe(PATIENT_ID);
    expect(insert.allowMinorEdits).toBe(true);
  });

  it("accepts a channel-subset grant, and checkConsent scopes to it", () => {
    const insert = grantConsent(input({ channels: ["website", "email"] }));
    const rows = [insert];
    expect(checkConsent(rows, "website").allowed).toBe(true);
    expect(checkConsent(rows, "email").allowed).toBe(true);
    expect(checkConsent(rows, "gbp")).toMatchObject({
      allowed: false,
      reason: "channel_not_granted",
    });
  });

  it("rejects a channel outside the vocabulary", () => {
    expect(() =>
      grantConsent(input({ channels: ["facebook" as never] })),
    ).toThrow(ZodError);
  });

  it("rejects a missing attribution", () => {
    expect(() =>
      grantConsent(input({ attribution: undefined as never })),
    ).toThrow(ZodError);
  });

  it("rejects a non-uuid signal id", () => {
    expect(() => grantConsent(input({ signalId: "signal-1" }))).toThrow(
      ZodError,
    );
  });
});
