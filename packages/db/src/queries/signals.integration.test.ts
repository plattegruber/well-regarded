/**
 * `insertNormalizedSignals` (issue #104): idempotent inserts against the
 * `(practice_id, source_kind, source_id)` partial unique index — new rows
 * report `created`, re-imports report `conflict` with the EXISTING row's id,
 * and null-sourceId rows always insert.
 */

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { practice } from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import { signals } from "../schema/signals.js";
import { insertNormalizedSignals, type SignalInsert } from "./signals.js";

const t = setupTestDb();

function row(
  practiceId: string,
  sourceId: string | null,
  overrides: Partial<SignalInsert> = {},
): SignalInsert {
  return {
    practiceId,
    sourceKind: "google",
    sourceId,
    occurredAt: new Date("2026-03-02T14:30:00Z"),
    originalText: `text for ${sourceId ?? "manual"}`,
    visibility: "public",
    pipelineStatus: "pending_dedupe",
    ...overrides,
  };
}

describe("insertNormalizedSignals", () => {
  it("inserts new rows as created with pending_dedupe status", async () => {
    const p = await practice(t.db);
    const outcomes = await insertNormalizedSignals(t.db, [
      row(p.id, "r1"),
      row(p.id, "r2"),
    ]);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.outcome === "created")).toBe(true);

    const stored = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, p.id));
    expect(stored).toHaveLength(2);
    expect(stored.every((s) => s.pipelineStatus === "pending_dedupe")).toBe(
      true,
    );
  });

  it("routes re-imports to conflict with the existing row's id", async () => {
    const p = await practice(t.db);
    const [first] = await insertNormalizedSignals(t.db, [row(p.id, "r1")]);

    const outcomes = await insertNormalizedSignals(t.db, [
      row(p.id, "r1"),
      row(p.id, "r3"),
    ]);
    const conflict = outcomes.find((o) => o.outcome === "conflict");
    const created = outcomes.find((o) => o.outcome === "created");
    expect(conflict).toMatchObject({
      sourceId: "r1",
      signalId: first?.signalId,
    });
    expect(created?.sourceId).toBe("r3");

    const stored = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, p.id));
    expect(stored).toHaveLength(2);
  });

  it("always inserts null-sourceId rows (no conflict target)", async () => {
    const p = await practice(t.db);
    const one = await insertNormalizedSignals(t.db, [
      row(p.id, null, { sourceKind: "manual", visibility: "private" }),
    ]);
    const two = await insertNormalizedSignals(t.db, [
      row(p.id, null, { sourceKind: "manual", visibility: "private" }),
    ]);
    expect(one[0]?.outcome).toBe("created");
    expect(two[0]?.outcome).toBe("created");
    const stored = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, p.id));
    expect(stored).toHaveLength(2);
  });

  it("returns [] for an empty batch", async () => {
    expect(await insertNormalizedSignals(t.db, [])).toEqual([]);
  });
});
