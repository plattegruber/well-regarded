import { beforeAll, describe, expect, it } from "vitest";

import { consent, practice, signal } from "../../test/factories.js";
import { pgError, setupTestDb } from "../../test/harness.js";
import { consents } from "../schema/consents.js";
import { isPublishable, revokeConsent } from "./consents.js";

/**
 * Integration tests for the consents table and publication gate
 * (migration 0006, issue #38) against a real Postgres, on the #49 harness
 * (own database per file, factories for fixtures, no cleanup needed). The
 * `consent()` factory grants through `grantConsent`, so version math is
 * always the sanctioned path. Run locally with:
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

    const revoked = await revokeConsent(
      t.db,
      s.id,
      new Date("2026-05-03T00:00:00Z"),
    );
    expect(revoked?.consentVersion).toBe(1);
    expect(revoked?.revokedAt).toBeInstanceOf(Date);

    const decision = await isPublishable(t.db, s.id, "website");
    expect(decision.publishable).toBe(false);
    expect(decision.reason).toBe("revoked");

    // Re-grant after revocation is a new row with a higher version — and
    // publishable again.
    const regrant = await consent(t.db, grantInput(s.id));
    expect(regrant.consentVersion).toBe(2);
    const after = await isPublishable(t.db, s.id, "website");
    expect(after).toMatchObject({ publishable: true, reason: "ok" });
  });

  it("isPublishable reports no_consent for a signal with no rows", async () => {
    const s = await insertSignal();
    const decision = await isPublishable(t.db, s.id, "website");
    expect(decision).toEqual({ publishable: false, reason: "no_consent" });
  });

  it("revokeConsent returns undefined when there is nothing active to revoke", async () => {
    const s = await insertSignal();
    const result = await revokeConsent(t.db, s.id, new Date());
    expect(result).toBeUndefined();
  });
});
