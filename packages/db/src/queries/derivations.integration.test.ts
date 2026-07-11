import { beforeAll, describe, expect, it } from "vitest";

import { derivation, practice, signal } from "../../test/factories.js";
import { pgError, setupTestDb } from "../../test/harness.js";
import {
  getCurrentDerivations,
  getCurrentDerivationsForSignals,
} from "./derivations.js";

/**
 * Integration tests for derivation resolution (migration 0005, issue #36)
 * against a real Postgres, on the #49 harness (own database per file,
 * factories for fixtures, no cleanup needed). Run locally with:
 *
 *   docker compose up -d && pnpm --filter @wellregarded/db test:integration
 */

const CHECK_VIOLATION = "23514";

describe("derivation resolution (integration)", () => {
  const t = setupTestDb();
  let practiceId: string;

  beforeAll(async () => {
    practiceId = (await practice(t.db)).id;
  });

  function insertSignal() {
    return signal(t.db, {
      practiceId,
      occurredAt: new Date("2026-05-01T00:00:00Z"),
      originalText: "Fixture signal for derivations.",
    });
  }

  it("two inferred_text rows at different timestamps → current = newer", async () => {
    const s = await insertSignal();
    await derivation(t.db, {
      signalId: s.id,
      practiceId,
      value: "negative",
      createdAt: new Date("2026-05-01T10:00:00Z"),
    });
    const newer = await derivation(t.db, {
      signalId: s.id,
      practiceId,
      value: "positive",
      createdAt: new Date("2026-05-02T10:00:00Z"),
    });

    const current = await getCurrentDerivations(t.db, s.id);
    expect(current.sentiment?.id).toBe(newer.id);
    expect(current.sentiment?.value).toBe("positive");
  });

  it("an older manual row beats a newer inferred_text row (the key test)", async () => {
    const s = await insertSignal();
    const manual = await derivation(t.db, {
      signalId: s.id,
      practiceId,
      basis: "manual",
      value: "positive",
      confidence: 1,
      createdAt: new Date("2026-05-01T10:00:00Z"),
    });
    expect(manual.modelVersion).toBeNull();
    await derivation(t.db, {
      signalId: s.id,
      practiceId,
      basis: "inferred_text",
      value: "negative",
      createdAt: new Date("2026-06-01T10:00:00Z"),
    });

    // A human correction must never be silently overridden by a newer
    // model run.
    const current = await getCurrentDerivations(t.db, s.id);
    expect(current.sentiment?.id).toBe(manual.id);
    expect(current.sentiment?.basis).toBe("manual");
  });

  it("derivations on 2 of 4 dimensions → those 2 populated, others undefined", async () => {
    const s = await insertSignal();
    await derivation(t.db, {
      signalId: s.id,
      practiceId,
      dimension: "sentiment",
    });
    await derivation(t.db, {
      signalId: s.id,
      practiceId,
      dimension: "urgency",
      value: 0.7,
    });

    const current = await getCurrentDerivations(t.db, s.id);
    expect(current.sentiment).toBeDefined();
    expect(current.urgency).toBeDefined();
    expect(current.urgency?.value).toBe(0.7);
    expect(current.response_risk).toBeUndefined();
    expect(current.publication_suitability).toBeUndefined();
  });

  it("rejects confidence = 1.2 via the CHECK constraint", async () => {
    const s = await insertSignal();
    const { code } = await pgError(
      derivation(t.db, { signalId: s.id, practiceId, confidence: 1.2 }),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it("getCurrentDerivationsForSignals across 3 signals returns each signal's own current rows in one query", async () => {
    const [a, b, c] = await Promise.all([
      insertSignal(),
      insertSignal(),
      insertSignal(),
    ]);
    const aManual = await derivation(t.db, {
      signalId: a.id,
      practiceId,
      basis: "manual",
      value: "positive",
      createdAt: new Date("2026-05-01T00:00:00Z"),
    });
    await derivation(t.db, {
      signalId: a.id,
      practiceId,
      value: "negative",
      createdAt: new Date("2026-05-02T00:00:00Z"),
    });
    const bCurrent = await derivation(t.db, {
      signalId: b.id,
      practiceId,
      dimension: "urgency",
      value: 0.2,
      createdAt: new Date("2026-05-03T00:00:00Z"),
    });
    // c has no derivations.

    const result = await getCurrentDerivationsForSignals(t.db, [
      a.id,
      b.id,
      c.id,
    ]);
    expect(result[a.id]?.sentiment?.id).toBe(aManual.id);
    expect(result[b.id]?.urgency?.id).toBe(bCurrent.id);
    expect(result[b.id]?.sentiment).toBeUndefined();
    expect(result[c.id]).toBeDefined();
    expect(
      Object.values(result[c.id] ?? {}).every((v) => v === undefined),
    ).toBe(true);
  });
});
