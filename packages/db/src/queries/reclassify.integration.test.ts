/**
 * Integration coverage for manual reclassification (issue #93):
 * append-only manual derivations (AI rows intact, manual outranks — even
 * against later AI runs), the one-click confirm, association
 * confirm/correct with hint rewriting, and the audit trail every write
 * leaves behind.
 */

import type { Actor } from "@wellregarded/core";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  derivation,
  location,
  practice,
  provider,
  signal,
  staffMember,
} from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import { auditLog } from "../schema/audit.js";
import { derivations } from "../schema/derivations.js";
import { signals } from "../schema/signals.js";
import { getCurrentDerivations } from "./derivations.js";
import {
  confirmDerivation,
  reclassifyDerivation,
  setSignalAssociation,
} from "./reclassify.js";

const t = setupTestDb();

async function actorFor(practiceId: string): Promise<Actor> {
  const staff = await staffMember(t.db, { practiceId });
  return { type: "staff", id: staff.id };
}

async function allRows(signalId: string, dimension: "sentiment" | "urgency") {
  return t.db
    .select()
    .from(derivations)
    .where(
      and(
        eq(derivations.signalId, signalId),
        eq(derivations.dimension, dimension),
      ),
    )
    .orderBy(asc(derivations.createdAt));
}

async function auditRows(action: string, entityId: string) {
  return t.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));
}

describe("reclassifyDerivation (integration)", () => {
  it("inserts a NEW manual row — the AI row is intact and outranked", async () => {
    const s = await signal(t.db);
    const actor = await actorFor(s.practiceId);
    const ai = await derivation(t.db, {
      signalId: s.id,
      practiceId: s.practiceId,
      dimension: "sentiment",
      value: "positive",
      basis: "inferred_text",
      confidence: 0.8,
    });

    const manual = await reclassifyDerivation(t.db, {
      practiceId: s.practiceId,
      signalId: s.id,
      dimension: "sentiment",
      value: "negative",
      actor,
    });

    expect(manual).toMatchObject({
      basis: "manual",
      value: "negative",
      confidence: 1,
      modelVersion: null,
      rationale: null,
    });

    // Append-only: two rows, the AI one byte-for-byte untouched.
    const rows = await allRows(s.id, "sentiment");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(ai);

    // The manual row is current.
    const current = await getCurrentDerivations(t.db, s.id);
    expect(current.sentiment?.id).toBe(manual?.id);

    // Audited: old current value → new value.
    if (!manual) throw new Error("expected a manual row");
    const audits = await auditRows("derivation.corrected", manual.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      practiceId: s.practiceId,
      actorType: "staff",
      entityType: "derivations",
      payload: {
        signalId: s.id,
        dimension: "sentiment",
        before: { value: "positive", basis: "inferred_text" },
        after: { value: "negative" },
      },
    });
  });

  it("a later AI re-classification does not override the manual row", async () => {
    const s = await signal(t.db);
    const actor = await actorFor(s.practiceId);
    await derivation(t.db, {
      signalId: s.id,
      practiceId: s.practiceId,
      dimension: "urgency",
      value: "low",
      basis: "inferred_text",
      createdAt: new Date("2026-07-01T00:00:00Z"),
    });
    const manual = await reclassifyDerivation(t.db, {
      practiceId: s.practiceId,
      signalId: s.id,
      dimension: "urgency",
      value: "high",
      actor,
    });
    // A newer model run lands after the correction…
    await derivation(t.db, {
      signalId: s.id,
      practiceId: s.practiceId,
      dimension: "urgency",
      value: "none",
      basis: "inferred_text",
      createdAt: new Date("2027-01-01T00:00:00Z"),
    });
    // …and the human's judgment still wins.
    const current = await getCurrentDerivations(t.db, s.id);
    expect(current.urgency?.id).toBe(manual?.id);
    expect(current.urgency?.value).toBe("high");
  });

  it("returns undefined for a cross-practice signal and writes nothing", async () => {
    const s = await signal(t.db);
    const other = await practice(t.db);
    const actor = await actorFor(other.id);
    const result = await reclassifyDerivation(t.db, {
      practiceId: other.id,
      signalId: s.id,
      dimension: "sentiment",
      value: "negative",
      actor,
    });
    expect(result).toBeUndefined();
    expect(await allRows(s.id, "sentiment")).toHaveLength(0);
  });
});

describe("confirmDerivation — the one-click ✓ (integration)", () => {
  it("writes a manual row matching the current value, audited as confirmed", async () => {
    const s = await signal(t.db);
    const actor = await actorFor(s.practiceId);
    await derivation(t.db, {
      signalId: s.id,
      practiceId: s.practiceId,
      dimension: "sentiment",
      value: "mixed",
      basis: "inferred_text",
      confidence: 0.7,
    });

    const confirmed = await confirmDerivation(t.db, {
      practiceId: s.practiceId,
      signalId: s.id,
      dimension: "sentiment",
      actor,
    });
    expect(confirmed).toMatchObject({
      basis: "manual",
      value: "mixed",
      confidence: 1,
    });
    if (!confirmed) throw new Error("expected a manual row");
    const audits = await auditRows("derivation.confirmed", confirmed.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.payload).toMatchObject({
      before: { value: "mixed", basis: "inferred_text" },
      after: { value: "mixed" },
    });

    // A second ✓ (stale double-click) is a quiet no-op — the current row
    // is already manual.
    const again = await confirmDerivation(t.db, {
      practiceId: s.practiceId,
      signalId: s.id,
      dimension: "sentiment",
      actor,
    });
    expect(again).toBeUndefined();
    expect(await allRows(s.id, "sentiment")).toHaveLength(2);
  });

  it("is a quiet no-op when there is no current judgment", async () => {
    const s = await signal(t.db);
    const actor = await actorFor(s.practiceId);
    const result = await confirmDerivation(t.db, {
      practiceId: s.practiceId,
      signalId: s.id,
      dimension: "urgency",
      actor,
    });
    expect(result).toBeUndefined();
    expect(await allRows(s.id, "urgency")).toHaveLength(0);
  });
});

describe("setSignalAssociation (integration)", () => {
  it("resolving a provider hint sets the FK, rewrites the hint to manual, audits", async () => {
    const p = await practice(t.db);
    const actor = await actorFor(p.id);
    const dr = await provider(t.db, { practiceId: p.id });
    const s = await signal(t.db, {
      practiceId: p.id,
      providerHint: { text: "Dr. Patel", basis: "inferred_text" },
    });

    const updated = await setSignalAssociation(t.db, {
      practiceId: p.id,
      signalId: s.id,
      kind: "provider",
      entityId: dr.id,
      actor,
    });
    expect(updated?.providerId).toBe(dr.id);
    // The source's own text is preserved; the basis records the human.
    expect(updated?.providerHint).toEqual({
      text: "Dr. Patel",
      basis: "manual",
    });

    const audits = await auditRows("signal.association_corrected", s.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.payload).toMatchObject({
      kind: "provider",
      beforeId: null,
      afterId: dr.id,
      hintBasisBefore: "inferred_text",
    });
  });

  it("'none/unknown' clears the FK and keeps the reviewed hint as manual", async () => {
    const p = await practice(t.db);
    const actor = await actorFor(p.id);
    const loc = await location(t.db, { practiceId: p.id });
    const s = await signal(t.db, {
      practiceId: p.id,
      locationId: loc.id,
      locationHint: { text: "the north office", basis: "inferred_text" },
    });

    const updated = await setSignalAssociation(t.db, {
      practiceId: p.id,
      signalId: s.id,
      kind: "location",
      entityId: null,
      actor,
    });
    expect(updated?.locationId).toBeNull();
    // The hint no longer re-surfaces as inferred.
    expect(updated?.locationHint).toEqual({
      text: "the north office",
      basis: "manual",
    });
    const audits = await auditRows("signal.association_corrected", s.id);
    expect(audits[0]?.payload).toMatchObject({
      kind: "location",
      beforeId: loc.id,
      afterId: null,
    });
  });

  it("blessing the existing FK audits as confirmed", async () => {
    const p = await practice(t.db);
    const actor = await actorFor(p.id);
    const dr = await provider(t.db, { practiceId: p.id });
    const s = await signal(t.db, { practiceId: p.id, providerId: dr.id });

    const updated = await setSignalAssociation(t.db, {
      practiceId: p.id,
      signalId: s.id,
      kind: "provider",
      entityId: dr.id,
      actor,
    });
    expect(updated?.providerId).toBe(dr.id);
    expect(updated?.providerHint).toEqual({
      text: dr.displayName,
      basis: "manual",
    });
    const audits = await auditRows("signal.association_confirmed", s.id);
    expect(audits).toHaveLength(1);
  });

  it("refuses an entity from another practice — undefined, nothing changes", async () => {
    const p = await practice(t.db);
    const actor = await actorFor(p.id);
    const foreign = await provider(t.db); // its own practice
    const s = await signal(t.db, { practiceId: p.id });

    const result = await setSignalAssociation(t.db, {
      practiceId: p.id,
      signalId: s.id,
      kind: "provider",
      entityId: foreign.id,
      actor,
    });
    expect(result).toBeUndefined();
    const [row] = await t.db.select().from(signals).where(eq(signals.id, s.id));
    expect(row?.providerId).toBeNull();
  });
});
