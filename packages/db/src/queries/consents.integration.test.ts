import { beforeAll, describe, expect, it } from "vitest";

import {
  consent,
  placement,
  practice,
  proof,
  signal,
} from "../../test/factories.js";
import { pgError, setupTestDb } from "../../test/harness.js";
import { consents } from "../schema/consents.js";
import { isPublishable, revokeConsent } from "./consents.js";

/**
 * Integration tests for the consents table and publication gate
 * (migration 0006, issues #38 and #84) against a real Postgres, on the #49
 * harness (own database per file, factories for fixtures, no cleanup
 * needed). The `consent()` factory grants through `grantConsent`, so
 * version math is always the sanctioned path. Run locally with:
 *
 *   docker compose up -d && pnpm --filter @wellregarded/db test:integration
 */

const UNIQUE_VIOLATION = "23505";

describe("consents (integration)", () => {
  const t = setupTestDb();
  let practiceId: string;

  beforeAll(async () => {
    practiceId = (await practice(t.db)).id;
  });

  function insertSignal() {
    return signal(t.db, {
      practiceId,
      sourceKind: "firstparty",
      occurredAt: new Date("2026-05-01T00:00:00Z"),
      originalText: "Fixture signal for consents.",
    });
  }

  function grantInput(signalId: string) {
    return {
      practiceId,
      signalId,
      grantedAt: new Date("2026-05-02T00:00:00Z"),
    };
  }

  it("grantConsent twice assigns versions 1 and 2", async () => {
    const s = await insertSignal();
    const v1 = await consent(t.db, grantInput(s.id));
    expect(v1.consentVersion).toBe(1);
    expect(v1.allowMinorEdits).toBe(false);
    expect(v1.patientId).toBeNull();
    expect(v1.channels).toEqual(["website"]);
    expect(v1.attribution).toBe("first_name");
    expect(v1.source).toBe("patient_link");

    const v2 = await consent(t.db, {
      ...grantInput(s.id),
      channels: ["website", "gbp"],
    });
    expect(v2.consentVersion).toBe(2);
    expect(v2.channels).toEqual(["website", "gbp"]);
  });

  it("versions are per signal — a second signal starts back at 1", async () => {
    const [a, b] = await Promise.all([insertSignal(), insertSignal()]);
    await consent(t.db, grantInput(a.id));
    const first = await consent(t.db, grantInput(b.id));
    expect(first.consentVersion).toBe(1);
  });

  it("a version conflict surfaces as a unique violation (retryable, never mis-versioned)", async () => {
    const s = await insertSignal();
    await consent(t.db, grantInput(s.id));

    // Simulate the losing side of a concurrent grant: same version inserted
    // directly, as if both transactions read max(consent_version) = 1.
    const raw = {
      practiceId,
      signalId: s.id,
      channels: ["website" as const],
      attribution: "first_name" as const,
      grantedAt: new Date("2026-05-02T00:00:00Z"),
      source: "patient_link" as const,
      consentVersion: 2,
    };
    const { code } = await pgError(t.db.insert(consents).values(raw));
    expect(code).toBe("no error thrown");
    const duplicate = await pgError(t.db.insert(consents).values(raw));
    expect(duplicate.code).toBe(UNIQUE_VIOLATION);
  });

  it("isPublishable end-to-end: ok on the granted channel, wrong channel refused with a reason", async () => {
    const s = await insertSignal();
    await consent(t.db, {
      ...grantInput(s.id),
      channels: ["website", "email"],
    });

    const ok = await isPublishable(t.db, s.id, "website");
    expect(ok.publishable).toBe(true);
    expect(ok.reason).toBe("ok");
    expect(ok.consent?.attribution).toBe("first_name");

    const wrongChannel = await isPublishable(t.db, s.id, "gbp");
    expect(wrongChannel.publishable).toBe(false);
    expect(wrongChannel.reason).toBe("channel_not_granted");
  });

  it("isPublishable end-to-end: revocation flips the decision to revoked", async () => {
    const s = await insertSignal();
    await consent(t.db, grantInput(s.id));

    // Revocation is a new version row (issue #84), never an UPDATE.
    const { revocation, effective } = await revokeConsent(t.db, {
      signalId: s.id,
      source: "patient_link",
      revokedAt: new Date("2026-05-03T00:00:00Z"),
    });
    expect(effective).toBe(true);
    expect(revocation?.consentVersion).toBe(2);
    expect(revocation?.revokedAt).toBeInstanceOf(Date);
    expect(revocation?.source).toBe("patient_link");

    const decision = await isPublishable(t.db, s.id, "website");
    expect(decision.publishable).toBe(false);
    expect(decision.reason).toBe("revoked");

    // Re-grant after revocation is a new row with a higher version — and
    // publishable again.
    const regrant = await consent(t.db, grantInput(s.id));
    expect(regrant.consentVersion).toBe(3);
    const after = await isPublishable(t.db, s.id, "website");
    expect(after).toMatchObject({ publishable: true, reason: "ok" });
  });

  it("revokeConsent returns the purge contract — the signal's proofs and their active placements (#96)", async () => {
    const s = await insertSignal();
    await consent(t.db, grantInput(s.id));

    // No proofs yet: an effective revocation with nothing to purge.
    const bare = await revokeConsent(t.db, {
      signalId: s.id,
      source: "patient_link",
      revokedAt: new Date("2026-05-03T00:00:00Z"),
    });
    expect(bare.effective).toBe(true);
    expect(bare.affectedProofIds).toEqual([]);
    expect(bare.affectedPlacementIds).toEqual([]);

    // Re-grant, add a proof with one active and one deactivated placement:
    // the purge contract names the proof and ONLY the active placement.
    await consent(t.db, grantInput(s.id));
    const affected = await proof(t.db, { signalId: s.id, status: "approved" });
    const live = await placement(t.db, { proofId: affected.id });
    await placement(t.db, {
      proofId: affected.id,
      channel: "email",
      active: false,
      deactivatedAt: new Date("2026-05-04T00:00:00Z"),
      deactivationReason: "staff choice",
    });

    const result = await revokeConsent(t.db, {
      signalId: s.id,
      source: "patient_link",
      revokedAt: new Date("2026-05-05T00:00:00Z"),
    });
    expect(result.effective).toBe(true);
    expect(result.affectedProofIds).toEqual([affected.id]);
    expect(result.affectedPlacementIds).toEqual([live.id]);
  });

  it("patient always wins: a staff attestation after a patient revocation stays unpublishable", async () => {
    const s = await insertSignal();
    await consent(t.db, { ...grantInput(s.id), source: "practice_attested" });
    await revokeConsent(t.db, {
      signalId: s.id,
      source: "patient_link",
      revokedAt: new Date("2026-05-03T00:00:00Z"),
    });

    // Staff try to re-enable via the attestation path — the patient_link
    // revocation row still governs (precedence, issue #84).
    await consent(t.db, { ...grantInput(s.id), source: "practice_attested" });
    const decision = await isPublishable(t.db, s.id, "website");
    expect(decision.publishable).toBe(false);
    expect(decision.reason).toBe("revoked");
  });

  it("patient always wins: a staff revocation is recorded but cannot silence a patient grant", async () => {
    const s = await insertSignal();
    await consent(t.db, { ...grantInput(s.id), source: "practice_attested" });
    await consent(t.db, { ...grantInput(s.id), source: "patient_link" });

    const result = await revokeConsent(t.db, {
      signalId: s.id,
      source: "practice_attested",
      revokedAt: new Date("2026-05-03T00:00:00Z"),
    });
    expect(result.effective).toBe(false);
    expect(result.revocation?.source).toBe("practice_attested");
    expect(result.affectedProofIds).toEqual([]);

    const decision = await isPublishable(t.db, s.id, "website");
    expect(decision).toMatchObject({ publishable: true, reason: "ok" });
  });

  it("isPublishable reports no_consent for a signal with no rows", async () => {
    const s = await insertSignal();
    const decision = await isPublishable(t.db, s.id, "website");
    expect(decision).toEqual({ publishable: false, reason: "no_consent" });
  });

  it("revokeConsent records nothing when there is nothing to revoke", async () => {
    const s = await insertSignal();
    const result = await revokeConsent(t.db, {
      signalId: s.id,
      source: "patient_link",
      revokedAt: new Date(),
    });
    expect(result).toEqual({
      revocation: undefined,
      effective: false,
      affectedProofIds: [],
      affectedPlacementIds: [],
    });
  });
});
