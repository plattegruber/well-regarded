import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { practice, signal } from "../../test/factories.js";
import { pgError, setupTestDb } from "../../test/harness.js";
import { signals } from "./signals.js";

/**
 * Integration tests for the signals table (migrations 0003 + 0004, issue
 * #35) against a real Postgres, on the #49 harness (own database per file,
 * factories for fixtures, no cleanup needed). Run locally with:
 *
 *   docker compose up -d && pnpm --filter @wellregarded/db test:integration
 */

const UNIQUE_VIOLATION = "23505";
/** RAISE EXCEPTION in a plpgsql trigger without an explicit ERRCODE. */
const RAISE_EXCEPTION = "P0001";

describe("signals table (integration)", () => {
  const t = setupTestDb();

  it("inserts a full-provenance Google signal and reads it back", async () => {
    const row = await signal(t.db, {
      sourceKind: "google",
      sourceId: "accounts/1/locations/2/reviews/full-provenance",
      sourceUrl: "https://maps.google.com/example-review",
      occurredAt: new Date("2026-05-01T12:00:00Z"),
      rawArtifactKey: "raw/google/full-provenance.json",
      originalText: "Dr. Shah was wonderful with my kids.",
      originalRating: "5.0",
      visibility: "public",
    });

    expect(row.availability).toBe("available");
    expect(row.retentionState).toBe("active");
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
    expect(row.patientId).toBeNull();

    const [fetched] = await t.db
      .select()
      .from(signals)
      .where(eq(signals.id, row.id));
    expect(fetched?.originalText).toBe("Dr. Shah was wonderful with my kids.");
    expect(fetched?.originalRating).toBe("5.0");
    expect(fetched?.sourceKind).toBe("google");
  });

  it("inserts a minimal manual signal (null source_id, source_url, original_rating)", async () => {
    const row = await signal(t.db, {
      originalText: "Patient mentioned the new hygienist was great.",
    });
    expect(row.sourceKind).toBe("manual");
    expect(row.sourceId).toBeNull();
    expect(row.sourceUrl).toBeNull();
    expect(row.originalRating).toBeNull();
  });

  it("rejects a duplicate (practice_id, source_kind, source_id), allows the same source_id in another practice, and allows repeated null source_ids", async () => {
    const practiceA = await practice(t.db);
    const practiceB = await practice(t.db);
    const sourceId = "reviews/dedupe/dup";
    const base = {
      sourceKind: "google" as const,
      sourceId,
      occurredAt: new Date("2026-05-03T10:00:00Z"),
      visibility: "public" as const,
    };

    await signal(t.db, { ...base, practiceId: practiceA.id });

    // Exact re-import must fail at the database (the Epic #6 dedupe stage's
    // last line of defense).
    const { code } = await pgError(
      t.db.insert(signals).values({ ...base, practiceId: practiceA.id }),
    );
    expect(code).toBe(UNIQUE_VIOLATION);

    // Same source_id under a different practice is a different signal.
    const other = await signal(t.db, { ...base, practiceId: practiceB.id });
    expect(other.sourceId).toBe(sourceId);

    // Partial index: two manual signals with null source_id both accepted.
    await signal(t.db, { practiceId: practiceA.id });
    await signal(t.db, { practiceId: practiceA.id });
    const manualRows = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, practiceA.id));
    expect(
      manualRows.filter((row) => row.sourceKind === "manual"),
    ).toHaveLength(2);
  });

  describe("signals_protect_original trigger (migration 0004)", () => {
    let counter = 0;

    async function insertProtected() {
      return signal(t.db, {
        sourceKind: "google",
        sourceId: `reviews/protected/${++counter}`,
        occurredAt: new Date("2026-05-04T08:00:00Z"),
        originalText: "The patient's words as captured.",
        originalRating: "4.0",
        visibility: "public",
      });
    }

    it("blocks editing original_text", async () => {
      const row = await insertProtected();
      const { code, message } = await pgError(
        t.db
          .update(signals)
          .set({ originalText: "edited" })
          .where(eq(signals.id, row.id)),
      );
      expect(code).toBe(RAISE_EXCEPTION);
      expect(message).toContain("immutable");
    });

    it("blocks editing original_rating", async () => {
      const row = await insertProtected();
      const { code } = await pgError(
        t.db
          .update(signals)
          .set({ originalRating: "1.0" })
          .where(eq(signals.id, row.id)),
      );
      expect(code).toBe(RAISE_EXCEPTION);
    });

    it("blocks nulling the content without the retention_state transition", async () => {
      const row = await insertProtected();
      const { code } = await pgError(
        t.db
          .update(signals)
          .set({ originalText: null, originalRating: null })
          .where(eq(signals.id, row.id)),
      );
      expect(code).toBe(RAISE_EXCEPTION);
    });

    it("allows updating unrelated columns (visibility alone) on the same row", async () => {
      const row = await insertProtected();
      const [updated] = await t.db
        .update(signals)
        .set({ visibility: "private" })
        .where(eq(signals.id, row.id))
        .returning();
      expect(updated?.visibility).toBe("private");
      expect(updated?.originalText).toBe(row.originalText);
    });

    it("allows the redaction carve-out: retention_state = 'redacted' with nulled content", async () => {
      const row = await insertProtected();
      const [redacted] = await t.db
        .update(signals)
        .set({
          retentionState: "redacted",
          originalText: null,
          originalRating: null,
        })
        .where(eq(signals.id, row.id))
        .returning();
      expect(redacted?.retentionState).toBe("redacted");
      expect(redacted?.originalText).toBeNull();
      expect(redacted?.originalRating).toBeNull();
    });

    it("still blocks rewriting content to non-null values during redaction", async () => {
      const row = await insertProtected();
      const { code } = await pgError(
        t.db
          .update(signals)
          .set({ retentionState: "redacted", originalText: "scrubbed" })
          .where(eq(signals.id, row.id)),
      );
      expect(code).toBe(RAISE_EXCEPTION);
    });
  });
});
