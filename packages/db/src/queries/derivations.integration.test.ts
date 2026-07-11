import { randomUUID } from "node:crypto";

import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type Db, type Sql } from "../client.js";
import { derivations } from "../schema/derivations.js";
import { signals } from "../schema/signals.js";
import { practices } from "../schema/tenancy.js";
import {
  getCurrentDerivations,
  getCurrentDerivationsForSignals,
} from "./derivations.js";

/**
 * Integration tests for derivation resolution (migration 0005, issue #36)
 * against a real Postgres.
 *
 * Run locally with:
 *
 *   docker compose up -d && pnpm db:migrate && \
 *     DATABASE_URL=postgres://... pnpm test:integration
 *
 * DATABASE_URL is asserted, never skipped (see CONTRIBUTING.md).
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL must be set to run integration tests " +
      "(local compose default: postgres://wellregarded:wellregarded@localhost:54322/wellregarded). " +
      "Integration tests never skip — a missing database is a failure.",
  );
}

const CHECK_VIOLATION = "23514";

async function pgErrorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? "";
  }
  return "no error thrown";
}

describe("derivation resolution (integration)", () => {
  let db: Db;
  let sql: Sql;
  const runId = randomUUID().slice(0, 8);
  let practiceId: string;

  beforeAll(async () => {
    ({ db, sql } = createDb(connectionString));
    const [practice] = await db
      .insert(practices)
      .values({
        clerkOrgId: `org_${runId}_derivations`,
        name: "Derivations Test Practice",
        slug: `derivations-test-${runId}`,
      })
      .returning();
    if (!practice) throw new Error("practice insert returned no row");
    practiceId = practice.id;
  });

  afterAll(async () => {
    // signals FK cascades to derivations.
    await db.delete(signals).where(inArray(signals.practiceId, [practiceId]));
    await db.delete(practices).where(inArray(practices.id, [practiceId]));
    await sql?.end();
  });

  async function insertSignal() {
    const [signal] = await db
      .insert(signals)
      .values({
        practiceId,
        sourceKind: "manual",
        occurredAt: new Date("2026-05-01T00:00:00Z"),
        originalText: "Fixture signal for derivations.",
        visibility: "private",
      })
      .returning();
    if (!signal) throw new Error("signal insert returned no row");
    return signal;
  }

  type InsertDerivation = Partial<typeof derivations.$inferInsert> & {
    signalId: string;
  };

  async function insertDerivation(values: InsertDerivation) {
    const [row] = await db
      .insert(derivations)
      .values({
        practiceId,
        dimension: "sentiment",
        value: "negative",
        confidence: 0.9,
        basis: "inferred_text",
        modelVersion: "test-model-1",
        ...values,
      })
      .returning();
    if (!row) throw new Error("derivation insert returned no row");
    return row;
  }

  it("two inferred_text rows at different timestamps → current = newer", async () => {
    const signal = await insertSignal();
    await insertDerivation({
      signalId: signal.id,
      value: "negative",
      createdAt: new Date("2026-05-01T10:00:00Z"),
    });
    const newer = await insertDerivation({
      signalId: signal.id,
      value: "positive",
      createdAt: new Date("2026-05-02T10:00:00Z"),
    });

    const current = await getCurrentDerivations(db, signal.id);
    expect(current.sentiment?.id).toBe(newer.id);
    expect(current.sentiment?.value).toBe("positive");
  });

  it("an older manual row beats a newer inferred_text row (the key test)", async () => {
    const signal = await insertSignal();
    const manual = await insertDerivation({
      signalId: signal.id,
      basis: "manual",
      modelVersion: null,
      value: "positive",
      confidence: 1,
      createdAt: new Date("2026-05-01T10:00:00Z"),
    });
    await insertDerivation({
      signalId: signal.id,
      basis: "inferred_text",
      value: "negative",
      createdAt: new Date("2026-06-01T10:00:00Z"),
    });

    // A human correction must never be silently overridden by a newer
    // model run.
    const current = await getCurrentDerivations(db, signal.id);
    expect(current.sentiment?.id).toBe(manual.id);
    expect(current.sentiment?.basis).toBe("manual");
  });

  it("derivations on 2 of 4 dimensions → those 2 populated, others undefined", async () => {
    const signal = await insertSignal();
    await insertDerivation({ signalId: signal.id, dimension: "sentiment" });
    await insertDerivation({
      signalId: signal.id,
      dimension: "urgency",
      value: 0.7,
    });

    const current = await getCurrentDerivations(db, signal.id);
    expect(current.sentiment).toBeDefined();
    expect(current.urgency).toBeDefined();
    expect(current.urgency?.value).toBe(0.7);
    expect(current.response_risk).toBeUndefined();
    expect(current.publication_suitability).toBeUndefined();
  });

  it("rejects confidence = 1.2 via the CHECK constraint", async () => {
    const signal = await insertSignal();
    const code = await pgErrorCode(
      insertDerivation({ signalId: signal.id, confidence: 1.2 }),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it("getCurrentDerivationsForSignals across 3 signals returns each signal's own current rows in one query", async () => {
    const [a, b, c] = await Promise.all([
      insertSignal(),
      insertSignal(),
      insertSignal(),
    ]);
    const aManual = await insertDerivation({
      signalId: a.id,
      basis: "manual",
      modelVersion: null,
      value: "positive",
      createdAt: new Date("2026-05-01T00:00:00Z"),
    });
    await insertDerivation({
      signalId: a.id,
      value: "negative",
      createdAt: new Date("2026-05-02T00:00:00Z"),
    });
    const bCurrent = await insertDerivation({
      signalId: b.id,
      dimension: "urgency",
      value: 0.2,
      createdAt: new Date("2026-05-03T00:00:00Z"),
    });
    // c has no derivations.

    const result = await getCurrentDerivationsForSignals(db, [
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
