import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type Db, type Sql } from "../client.js";
import { signals } from "./signals.js";
import { practices } from "./tenancy.js";

/**
 * Integration tests for the signals table (migrations 0003 + 0004, issue
 * #35) against a real Postgres.
 *
 * Run locally with:
 *
 *   docker compose up -d && pnpm db:migrate && \
 *     DATABASE_URL=postgres://... pnpm test:integration
 *
 * In CI the `integration` job provides the database and applies migrations
 * first. DATABASE_URL is asserted, never skipped — integration tests never
 * silently skip (see CONTRIBUTING.md). The per-test isolation harness is a
 * separate issue in Epic #3; until it lands these tests hit the shared
 * database directly (rows are suffixed with a run id and cleaned up in
 * afterAll).
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL must be set to run integration tests " +
      "(local compose default: postgres://wellregarded:wellregarded@localhost:54322/wellregarded). " +
      "Integration tests never skip — a missing database is a failure.",
  );
}

const UNIQUE_VIOLATION = "23505";
/** RAISE EXCEPTION in a plpgsql trigger without an explicit ERRCODE. */
const RAISE_EXCEPTION = "P0001";

/**
 * Extract the Postgres error code/message. drizzle-orm wraps driver errors
 * in DrizzleQueryError with the PostgresError on `cause`, so check both.
 */
async function pgError(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    const e = error as {
      code?: string;
      message?: string;
      cause?: { code?: string; message?: string };
    };
    return {
      code: e.code ?? e.cause?.code ?? "",
      message: [e.message, e.cause?.message].filter(Boolean).join(" | "),
    };
  }
  return { code: "no error thrown", message: "" };
}

describe("signals table (integration)", () => {
  let db: Db;
  let sql: Sql;
  const runId = randomUUID().slice(0, 8);
  const createdPracticeIds: string[] = [];

  beforeAll(() => {
    ({ db, sql } = createDb(connectionString));
  });

  afterAll(async () => {
    if (createdPracticeIds.length > 0) {
      await db
        .delete(signals)
        .where(inArray(signals.practiceId, createdPracticeIds));
      await db
        .delete(practices)
        .where(inArray(practices.id, createdPracticeIds));
    }
    await sql?.end();
  });

  async function insertPractice(suffix: string) {
    const [practice] = await db
      .insert(practices)
      .values({
        clerkOrgId: `org_${runId}_${suffix}`,
        name: `Signals Test Practice ${suffix}`,
        slug: `signals-test-${runId}-${suffix}`,
      })
      .returning();
    if (!practice) throw new Error("practice insert returned no row");
    createdPracticeIds.push(practice.id);
    return practice;
  }

  it("inserts a full-provenance Google signal and reads it back", async () => {
    const practice = await insertPractice("google");
    const [signal] = await db
      .insert(signals)
      .values({
        practiceId: practice.id,
        sourceKind: "google",
        sourceId: `accounts/1/locations/2/reviews/${runId}`,
        sourceUrl: "https://maps.google.com/example-review",
        occurredAt: new Date("2026-05-01T12:00:00Z"),
        rawArtifactKey: `raw/google/${runId}.json`,
        originalText: "Dr. Shah was wonderful with my kids.",
        originalRating: "5.0",
        visibility: "public",
      })
      .returning();
    if (!signal) throw new Error("signal insert returned no row");

    expect(signal.availability).toBe("available");
    expect(signal.retentionState).toBe("active");
    expect(signal.createdAt).toBeInstanceOf(Date);
    expect(signal.updatedAt).toBeInstanceOf(Date);
    expect(signal.patientId).toBeNull();

    const [fetched] = await db
      .select()
      .from(signals)
      .where(eq(signals.id, signal.id));
    expect(fetched?.originalText).toBe("Dr. Shah was wonderful with my kids.");
    expect(fetched?.originalRating).toBe("5.0");
    expect(fetched?.sourceKind).toBe("google");
  });

  it("inserts a minimal manual signal (null source_id, source_url, original_rating)", async () => {
    const practice = await insertPractice("manual");
    const [signal] = await db
      .insert(signals)
      .values({
        practiceId: practice.id,
        sourceKind: "manual",
        occurredAt: new Date("2026-05-02T09:00:00Z"),
        originalText: "Patient mentioned the new hygienist was great.",
        visibility: "private",
      })
      .returning();
    expect(signal?.sourceId).toBeNull();
    expect(signal?.sourceUrl).toBeNull();
    expect(signal?.originalRating).toBeNull();
  });

  it("rejects a duplicate (practice_id, source_kind, source_id), allows the same source_id in another practice, and allows repeated null source_ids", async () => {
    const practiceA = await insertPractice("dedupe-a");
    const practiceB = await insertPractice("dedupe-b");
    const sourceId = `reviews/${runId}/dup`;
    const base = {
      sourceKind: "google" as const,
      sourceId,
      occurredAt: new Date("2026-05-03T10:00:00Z"),
      visibility: "public" as const,
    };

    await db.insert(signals).values({ ...base, practiceId: practiceA.id });

    // Exact re-import must fail at the database (the Epic #6 dedupe stage's
    // last line of defense).
    const { code } = await pgError(
      db.insert(signals).values({ ...base, practiceId: practiceA.id }),
    );
    expect(code).toBe(UNIQUE_VIOLATION);

    // Same source_id under a different practice is a different signal.
    const [other] = await db
      .insert(signals)
      .values({ ...base, practiceId: practiceB.id })
      .returning();
    expect(other?.sourceId).toBe(sourceId);

    // Partial index: two manual signals with null source_id both accepted.
    const manual = {
      practiceId: practiceA.id,
      sourceKind: "manual" as const,
      occurredAt: new Date("2026-05-03T11:00:00Z"),
      visibility: "private" as const,
    };
    await db.insert(signals).values(manual);
    await db.insert(signals).values(manual);
    const manualRows = await db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, practiceA.id));
    expect(
      manualRows.filter((row) => row.sourceKind === "manual"),
    ).toHaveLength(2);
  });

  describe("signals_protect_original trigger (migration 0004)", () => {
    async function insertProtected() {
      const practice = await insertPractice(
        `trigger-${randomUUID().slice(0, 4)}`,
      );
      const [signal] = await db
        .insert(signals)
        .values({
          practiceId: practice.id,
          sourceKind: "google",
          sourceId: `reviews/${randomUUID()}`,
          occurredAt: new Date("2026-05-04T08:00:00Z"),
          originalText: "The patient's words as captured.",
          originalRating: "4.0",
          visibility: "public",
        })
        .returning();
      if (!signal) throw new Error("signal insert returned no row");
      return signal;
    }

    it("blocks editing original_text", async () => {
      const signal = await insertProtected();
      const { code, message } = await pgError(
        db
          .update(signals)
          .set({ originalText: "edited" })
          .where(eq(signals.id, signal.id)),
      );
      expect(code).toBe(RAISE_EXCEPTION);
      expect(message).toContain("immutable");
    });

    it("blocks editing original_rating", async () => {
      const signal = await insertProtected();
      const { code } = await pgError(
        db
          .update(signals)
          .set({ originalRating: "1.0" })
          .where(eq(signals.id, signal.id)),
      );
      expect(code).toBe(RAISE_EXCEPTION);
    });

    it("blocks nulling the content without the retention_state transition", async () => {
      const signal = await insertProtected();
      const { code } = await pgError(
        db
          .update(signals)
          .set({ originalText: null, originalRating: null })
          .where(eq(signals.id, signal.id)),
      );
      expect(code).toBe(RAISE_EXCEPTION);
    });

    it("allows updating unrelated columns (visibility alone) on the same row", async () => {
      const signal = await insertProtected();
      const [updated] = await db
        .update(signals)
        .set({ visibility: "private" })
        .where(eq(signals.id, signal.id))
        .returning();
      expect(updated?.visibility).toBe("private");
      expect(updated?.originalText).toBe(signal.originalText);
    });

    it("allows the redaction carve-out: retention_state = 'redacted' with nulled content", async () => {
      const signal = await insertProtected();
      const [redacted] = await db
        .update(signals)
        .set({
          retentionState: "redacted",
          originalText: null,
          originalRating: null,
        })
        .where(eq(signals.id, signal.id))
        .returning();
      expect(redacted?.retentionState).toBe("redacted");
      expect(redacted?.originalText).toBeNull();
      expect(redacted?.originalRating).toBeNull();
    });

    it("still blocks rewriting content to non-null values during redaction", async () => {
      const signal = await insertProtected();
      const { code } = await pgError(
        db
          .update(signals)
          .set({ retentionState: "redacted", originalText: "scrubbed" })
          .where(eq(signals.id, signal.id)),
      );
      expect(code).toBe(RAISE_EXCEPTION);
    });
  });
});
