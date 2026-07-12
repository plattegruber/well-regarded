/**
 * Integration tests for proofs + placements and the canonical
 * `publishableProofs` query (issue #96) against a real Postgres on the
 * #49 harness. The heart of the issue: the consent join is test-locked
 * against `checkConsent` in @wellregarded/core — including a
 * property-style check that the SQL agrees with filtering in JS over the
 * same rows. Run locally with:
 *
 *   docker compose up -d && pnpm --filter @wellregarded/db test:integration
 */

import { type ConsentChannel, checkConsent } from "@wellregarded/core";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  consent,
  location,
  placement,
  practice,
  proof,
  proofExcerpt,
  provider,
  signal,
  staffMember,
} from "../../test/factories.js";
import { pgError, setupTestDb } from "../../test/harness.js";
import { auditLog } from "../schema/audit.js";
import { consents } from "../schema/consents.js";
import { proofs } from "../schema/proofs.js";
import { revokeConsent } from "./consents.js";
import {
  placementsForSignal,
  publishableProofs,
  suggestProof,
} from "./proofs.js";

const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";

const ROUTE_ACTOR = { type: "system", id: "pipeline:route" } as const;

describe("publishableProofs (integration)", () => {
  const t = setupTestDb();

  /** A practice with one signal carrying an approved whole-signal proof. */
  async function approvedProof(overrides: {
    channels?: ConsentChannel[];
    expiresAt?: Date | null;
    displayText?: string | null;
  }) {
    const p = await practice(t.db);
    const s = await signal(t.db, {
      practiceId: p.id,
      originalText: "Dr. Patel explained every step and it was painless.",
    });
    await consent(t.db, {
      practiceId: p.id,
      signalId: s.id,
      channels: overrides.channels ?? ["website"],
      expiresAt: overrides.expiresAt ?? null,
    });
    const pr = await proof(t.db, {
      signalId: s.id,
      status: "approved",
      displayText: overrides.displayText ?? null,
    });
    return { p, s, pr };
  }

  it("returns an approved proof on the granted channel, not on an ungranted one", async () => {
    const { p, pr } = await approvedProof({ channels: ["website", "email"] });

    const onWebsite = await publishableProofs(t.db, p.id, "website");
    expect(onWebsite).toHaveLength(1);
    expect(onWebsite[0]?.proof.id).toBe(pr.id);
    // The winning consent row rides along for attribution rules.
    expect(onWebsite[0]?.consent).toMatchObject({
      channels: ["website", "email"],
      attribution: "first_name",
      consentVersion: 1,
    });

    // checkConsent's channel_not_granted: gbp was never granted.
    expect(await publishableProofs(t.db, p.id, "gbp")).toEqual([]);
  });

  it("never returns suggested or archived proofs, even fully consented", async () => {
    const p = await practice(t.db);
    for (const status of ["suggested", "archived"] as const) {
      const s = await signal(t.db, { practiceId: p.id });
      await consent(t.db, { signalId: s.id, channels: ["website"] });
      await proof(t.db, { signalId: s.id, status });
    }
    expect(await publishableProofs(t.db, p.id, "website")).toEqual([]);
  });

  it("revocation flips the result: returned → revoke → gone", async () => {
    const { p, s, pr } = await approvedProof({});
    expect(await publishableProofs(t.db, p.id, "website")).toHaveLength(1);

    // A revocation is a new consent version row (issue #84) — no proof
    // mutation anywhere, the join simply answers differently. The purge
    // contract carries the proof this cascade (#91) must clean up.
    const revoked = await revokeConsent(t.db, {
      signalId: s.id,
      source: "patient_link",
      revokedAt: new Date(),
    });
    expect(revoked.effective).toBe(true);
    expect(revoked.affectedProofIds).toEqual([pr.id]);
    expect(await publishableProofs(t.db, p.id, "website")).toEqual([]);

    // A re-grant is a new higher version — publishable again.
    await consent(t.db, { signalId: s.id, channels: ["website"] });
    expect(await publishableProofs(t.db, p.id, "website")).toHaveLength(1);
  });

  it("excludes expired consent (expires_at <= now), keeps future expiry", async () => {
    const now = new Date("2026-07-01T00:00:00Z");
    const expired = await approvedProof({
      expiresAt: new Date("2026-06-30T00:00:00Z"),
    });
    expect(
      await publishableProofs(t.db, expired.p.id, "website", { now }),
    ).toEqual([]);

    const future = await approvedProof({
      expiresAt: new Date("2026-08-01T00:00:00Z"),
    });
    expect(
      await publishableProofs(t.db, future.p.id, "website", { now }),
    ).toHaveLength(1);
  });

  it("patient always wins: a patient revocation beats a practice attestation, even a later one", async () => {
    const p = await practice(t.db);
    const s = await signal(t.db, { practiceId: p.id });
    await consent(t.db, {
      signalId: s.id,
      channels: ["website", "gbp"],
      source: "practice_attested",
    });
    await proof(t.db, { signalId: s.id, status: "approved" });
    expect(await publishableProofs(t.db, p.id, "website")).toHaveLength(1);

    // The patient revokes: the patient_link revocation row governs...
    await revokeConsent(t.db, {
      signalId: s.id,
      source: "patient_link",
      revokedAt: new Date(),
    });
    expect(await publishableProofs(t.db, p.id, "website")).toEqual([]);
    expect(await publishableProofs(t.db, p.id, "gbp")).toEqual([]);

    // ...and staff re-attesting afterwards changes nothing — the
    // patient_link partition beats staff sources regardless of version
    // (`governingConsent`, issue #84).
    await consent(t.db, {
      signalId: s.id,
      channels: ["website", "gbp"],
      source: "practice_attested",
    });
    expect(await publishableProofs(t.db, p.id, "website")).toEqual([]);
  });

  it("patient always wins: a staff revocation cannot silence a patient grant", async () => {
    const p = await practice(t.db);
    const s = await signal(t.db, { practiceId: p.id });
    await consent(t.db, {
      signalId: s.id,
      channels: ["website"],
      source: "patient_link",
    });
    await proof(t.db, { signalId: s.id, status: "approved" });

    const attempt = await revokeConsent(t.db, {
      signalId: s.id,
      source: "practice_attested",
      revokedAt: new Date(),
    });
    // Recorded as history, but not effective — and still served.
    expect(attempt.effective).toBe(false);
    expect(attempt.affectedProofIds).toEqual([]);
    expect(await publishableProofs(t.db, p.id, "website")).toHaveLength(1);
  });

  it("a signal with no consent rows never serves (no_consent)", async () => {
    const p = await practice(t.db);
    const s = await signal(t.db, { practiceId: p.id });
    await proof(t.db, { signalId: s.id, status: "approved" });
    expect(await publishableProofs(t.db, p.id, "website")).toEqual([]);
  });

  it("practice scoping: practice B never sees practice A's proofs", async () => {
    const { p } = await approvedProof({});
    const other = await practice(t.db);
    expect(await publishableProofs(t.db, p.id, "website")).toHaveLength(1);
    expect(await publishableProofs(t.db, other.id, "website")).toEqual([]);
  });

  it("joins the excerpt for excerpt-level proofs and falls back for display text", async () => {
    const p = await practice(t.db);
    const s = await signal(t.db, {
      practiceId: p.id,
      originalText: "Whole original text of the signal.",
    });
    await consent(t.db, { signalId: s.id, channels: ["website"] });
    const excerpt = await proofExcerpt(t.db, {
      signalId: s.id,
      excerptText: "the excerpt slice",
    });
    await proof(t.db, {
      signalId: s.id,
      excerptId: excerpt.id,
      status: "approved",
    });

    const [row] = await publishableProofs(t.db, p.id, "website");
    expect(row?.excerpt?.id).toBe(excerpt.id);
    expect(row?.excerpt?.excerptText).toBe("the excerpt slice");
    // display_text not initialized yet (#105): fall back to the excerpt.
    expect(row?.displayText).toBe("the excerpt slice");
    expect(row?.signal.originalText).toBe("Whole original text of the signal.");
  });

  it("display text prefers the proof's own display_text; whole-signal falls back to the original", async () => {
    const edited = await approvedProof({ displayText: "Edited for display" });
    const [editedRow] = await publishableProofs(t.db, edited.p.id, "website");
    expect(editedRow?.displayText).toBe("Edited for display");

    const bare = await approvedProof({});
    const [bareRow] = await publishableProofs(t.db, bare.p.id, "website");
    expect(bareRow?.excerpt).toBeNull();
    expect(bareRow?.displayText).toBe(
      "Dr. Patel explained every step and it was painless.",
    );
  });

  it("composable filters: location, provider, recency window, excerpt ids", async () => {
    const p = await practice(t.db);
    const loc = await location(t.db, { practiceId: p.id });
    const prov = await provider(t.db, { practiceId: p.id });

    async function approvedFor(overrides: Parameters<typeof signal>[1]) {
      const s = await signal(t.db, { practiceId: p.id, ...overrides });
      await consent(t.db, { signalId: s.id, channels: ["website"] });
      return {
        s,
        pr: await proof(t.db, { signalId: s.id, status: "approved" }),
      };
    }

    const recentAtLocation = await approvedFor({
      locationId: loc.id,
      occurredAt: new Date("2026-06-01T00:00:00Z"),
    });
    const oldWithProvider = await approvedFor({
      providerId: prov.id,
      occurredAt: new Date("2024-01-01T00:00:00Z"),
    });

    const atLocation = await publishableProofs(t.db, p.id, "website", {
      locationId: loc.id,
    });
    expect(atLocation.map((r) => r.proof.id)).toEqual([recentAtLocation.pr.id]);

    const withProvider = await publishableProofs(t.db, p.id, "website", {
      providerId: prov.id,
    });
    expect(withProvider.map((r) => r.proof.id)).toEqual([
      oldWithProvider.pr.id,
    ]);

    const recent = await publishableProofs(t.db, p.id, "website", {
      occurredSince: new Date("2026-01-01T00:00:00Z"),
    });
    expect(recent.map((r) => r.proof.id)).toEqual([recentAtLocation.pr.id]);

    // Excerpt-id restriction selects only excerpt-level proofs.
    const sx = await signal(t.db, { practiceId: p.id });
    await consent(t.db, { signalId: sx.id, channels: ["website"] });
    const excerpt = await proofExcerpt(t.db, { signalId: sx.id });
    const excerptProof = await proof(t.db, {
      signalId: sx.id,
      excerptId: excerpt.id,
      status: "approved",
    });
    const byExcerpt = await publishableProofs(t.db, p.id, "website", {
      excerptIds: [excerpt.id],
    });
    expect(byExcerpt.map((r) => r.proof.id)).toEqual([excerptProof.id]);
    expect(
      await publishableProofs(t.db, p.id, "website", { excerptIds: [] }),
    ).toEqual([]);
  });

  it("property check: the SQL agrees with checkConsent in JS over the same rows", async () => {
    const now = new Date("2026-07-10T12:00:00Z");
    const past = new Date("2026-01-01T00:00:00Z");
    const future = new Date("2027-01-01T00:00:00Z");
    const p = await practice(t.db);

    // A spread of consent shapes: none, wrong channel, active, expired,
    // future expiry, revoked (by patient and by staff), staff-attested
    // under and over patient rows, narrowed/widened chains — every proof
    // approved, so the consent join alone decides.
    type Source = "patient_link" | "practice_attested" | "imported_unknown";
    const shapes: {
      grants: {
        channels: ConsentChannel[];
        source?: Source;
        expiresAt?: Date;
      }[];
      /** Revoke after the nth grant, as this revoker. */
      revokeAfter?: number;
      revokeSource?: "patient_link" | "practice_attested";
    }[] = [
      { grants: [] },
      { grants: [{ channels: ["email"] }] },
      { grants: [{ channels: ["website"] }] },
      { grants: [{ channels: ["website"], expiresAt: past }] },
      { grants: [{ channels: ["website"], expiresAt: future }] },
      {
        grants: [{ channels: ["website"] }],
        revokeAfter: 1,
        revokeSource: "patient_link",
      },
      { grants: [{ channels: ["gbp"] }, { channels: ["website"] }] },
      { grants: [{ channels: ["website"] }, { channels: ["in_office"] }] },
      {
        grants: [{ channels: ["website"] }, { channels: ["website", "gbp"] }],
        revokeAfter: 2,
        revokeSource: "patient_link",
      },
      // Staff attestation only, staff-revoked.
      {
        grants: [{ channels: ["website"], source: "practice_attested" }],
        revokeAfter: 1,
        revokeSource: "practice_attested",
      },
      // Patient grant with a later staff attestation — patient governs.
      {
        grants: [
          { channels: ["website"] },
          { channels: ["website", "gbp"], source: "practice_attested" },
        ],
      },
      // Patient revocation, then staff try to re-attest — still refused.
      {
        grants: [
          { channels: ["website"] },
          { channels: ["website"], source: "practice_attested" },
        ],
        revokeAfter: 1,
        revokeSource: "patient_link",
      },
      // Staff revocation under a governing patient grant — ineffective.
      {
        grants: [
          { channels: ["website"], source: "practice_attested" },
          { channels: ["website"] },
        ],
        revokeAfter: 2,
        revokeSource: "practice_attested",
      },
      // Legacy import attestation.
      {
        grants: [{ channels: ["in_office"], source: "imported_unknown" }],
      },
    ];

    const signalIds: string[] = [];
    for (const shape of shapes) {
      const s = await signal(t.db, { practiceId: p.id });
      signalIds.push(s.id);
      let granted = 0;
      for (const grant of shape.grants) {
        await consent(t.db, {
          signalId: s.id,
          channels: grant.channels,
          source: grant.source ?? "patient_link",
          expiresAt: grant.expiresAt ?? null,
        });
        granted += 1;
        if (shape.revokeAfter === granted) {
          await revokeConsent(t.db, {
            signalId: s.id,
            source: shape.revokeSource ?? "patient_link",
            revokedAt: now,
          });
        }
      }
      await proof(t.db, { signalId: s.id, status: "approved" });
    }

    for (const channel of ["website", "gbp", "email", "in_office"] as const) {
      const sqlResult = await publishableProofs(t.db, p.id, channel, { now });
      const sqlSignalIds = new Set(sqlResult.map((r) => r.signal.id));

      const jsSignalIds = new Set<string>();
      for (const signalId of signalIds) {
        const rows = await t.db
          .select()
          .from(consents)
          .where(eq(consents.signalId, signalId));
        if (checkConsent(rows, channel, now).allowed) {
          jsSignalIds.add(signalId);
        }
      }
      expect(sqlSignalIds).toEqual(jsSignalIds);
    }
  });
});

describe("suggestProof (integration)", () => {
  const t = setupTestDb();

  it("creates a whole-signal suggested proof with its proof.suggested audit", async () => {
    const s = await signal(t.db);
    const result = await suggestProof(t.db, {
      practiceId: s.practiceId,
      signalId: s.id,
      actor: ROUTE_ACTOR,
      auditPayload: { importRunId: "run-1" },
    });

    expect(result.created).toBe(true);
    expect(result.proof).toMatchObject({
      practiceId: s.practiceId,
      signalId: s.id,
      excerptId: null,
      displayText: null,
      status: "suggested",
    });

    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, result.proof?.id ?? ""));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "proof.suggested",
      entityType: "proofs",
      actorType: "system",
      actorId: "pipeline:route",
      payload: { importRunId: "run-1" },
    });
  });

  it("is idempotent per signal: any non-archived proof blocks a new suggestion", async () => {
    const s = await signal(t.db);
    const first = await suggestProof(t.db, {
      practiceId: s.practiceId,
      signalId: s.id,
      actor: ROUTE_ACTOR,
    });
    const second = await suggestProof(t.db, {
      practiceId: s.practiceId,
      signalId: s.id,
      actor: ROUTE_ACTOR,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    const rows = await t.db
      .select()
      .from(proofs)
      .where(eq(proofs.signalId, s.id));
    expect(rows).toHaveLength(1);

    // An APPROVED excerpt-level proof blocks too — "any non-archived".
    const s2 = await signal(t.db);
    const excerpt = await proofExcerpt(t.db, { signalId: s2.id });
    await proof(t.db, {
      signalId: s2.id,
      excerptId: excerpt.id,
      status: "approved",
    });
    const blocked = await suggestProof(t.db, {
      practiceId: s2.practiceId,
      signalId: s2.id,
      actor: ROUTE_ACTOR,
    });
    expect(blocked.created).toBe(false);
  });

  it("an archived proof frees the signal for a fresh suggestion", async () => {
    const s = await signal(t.db);
    await proof(t.db, { signalId: s.id, status: "archived" });
    const result = await suggestProof(t.db, {
      practiceId: s.practiceId,
      signalId: s.id,
      actor: ROUTE_ACTOR,
    });
    expect(result.created).toBe(true);
  });
});

describe("proofs table constraints (integration)", () => {
  const t = setupTestDb();

  it("rejects an excerpt belonging to a different signal (composite FK)", async () => {
    const p = await practice(t.db);
    const a = await signal(t.db, { practiceId: p.id });
    const b = await signal(t.db, { practiceId: p.id });
    const excerptOfB = await proofExcerpt(t.db, { signalId: b.id });

    const { code } = await pgError(
      t.db.insert(proofs).values({
        practiceId: p.id,
        signalId: a.id,
        excerptId: excerptOfB.id,
        status: "suggested",
      }),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("allows at most one live whole-signal proof; archiving frees the slot", async () => {
    const s = await signal(t.db);
    await proof(t.db, { signalId: s.id, status: "approved" });

    const { code } = await pgError(
      t.db.insert(proofs).values({
        practiceId: s.practiceId,
        signalId: s.id,
        status: "suggested",
      }),
    );
    expect(code).toBe(UNIQUE_VIOLATION);

    await t.db
      .update(proofs)
      .set({ status: "archived" })
      .where(and(eq(proofs.signalId, s.id), eq(proofs.status, "approved")));
    await expect(proof(t.db, { signalId: s.id })).resolves.toMatchObject({
      status: "suggested",
    });
  });

  it("approval metadata round-trips (approved_by staff FK, approved_at)", async () => {
    const s = await signal(t.db);
    const approver = await staffMember(t.db, { practiceId: s.practiceId });
    const approvedAt = new Date("2026-07-01T00:00:00Z");
    const row = await proof(t.db, {
      signalId: s.id,
      status: "approved",
      displayText: "Approved display text",
      approvedBy: approver.id,
      approvedAt,
    });
    expect(row.approvedBy).toBe(approver.id);
    expect(row.approvedAt).toEqual(approvedAt);
  });
});

describe("placementsForSignal (integration)", () => {
  const t = setupTestDb();

  it("returns every placement across the signal's proofs, active or not", async () => {
    const s = await signal(t.db);
    const excerpt = await proofExcerpt(t.db, { signalId: s.id });
    const whole = await proof(t.db, { signalId: s.id, status: "approved" });
    const sliced = await proof(t.db, {
      signalId: s.id,
      excerptId: excerpt.id,
      status: "approved",
    });

    const live = await placement(t.db, {
      proofId: whole.id,
      channel: "website",
      target: "invisalign landing page",
    });
    const retired = await placement(t.db, {
      proofId: sliced.id,
      channel: "gbp_post",
      active: false,
      deactivatedAt: new Date(),
      deactivationReason: "consent_revoked",
    });
    // Another signal's placement never leaks in.
    await placement(t.db);

    const rows = await placementsForSignal(t.db, s.id);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.placement.id))).toEqual(
      new Set([live.id, retired.id]),
    );
    const retiredRow = rows.find((r) => r.placement.id === retired.id);
    expect(retiredRow).toMatchObject({
      proofId: sliced.id,
      proofStatus: "approved",
    });
    expect(retiredRow?.placement.deactivationReason).toBe("consent_revoked");
    expect(retiredRow?.placement.active).toBe(false);
  });

  it("returns [] for a signal with no proofs", async () => {
    const s = await signal(t.db);
    expect(await placementsForSignal(t.db, s.id)).toEqual([]);
  });
});
