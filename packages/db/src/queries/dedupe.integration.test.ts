/**
 * Dedupe queries against real Postgres + pgvector (issue #106): the ANN
 * candidate query (window/self/practice predicates, cosine similarity from
 * the HNSW-indexed column), the version-append update policy (original
 * content untouched — the 0004 trigger would raise otherwise), and the
 * canonical-pair idempotency of `suspected_duplicates`.
 */

import { FakeEmbeddingProvider } from "@wellregarded/ai";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { importRun, practice, signal } from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import { signalVersions, suspectedDuplicates } from "../schema/dedupe.js";
import { signals } from "../schema/signals.js";
import {
  canonicalPair,
  findDuplicateCandidates,
  getImportRunArtifactKeys,
  getSignalWithCurrentContent,
  insertSuspectedDuplicates,
  listSuspectedDuplicatesForImportRun,
  recordSignalVersion,
  updateSignalEmbedding,
} from "./dedupe.js";

const t = setupTestDb();
const embedder = new FakeEmbeddingProvider();

const reviewText =
  "Dr. Patel was wonderful with my daughter — she actually looks forward " +
  "to the dentist now and asks when we can go back for the next visit.";
const nearCopyText =
  "Dr. Patel was wonderful with my daughter - she actually looks forward " +
  "to the dentist now and asks when we can go back for the next visit!";
const unrelatedText =
  "Billing was a mess for months and nobody at the front desk could " +
  "explain the insurance charges on my statement or return my calls.";

const when = new Date("2026-05-10T10:00:00Z");

describe("findDuplicateCandidates (pgvector)", () => {
  it("returns the planted near-duplicate with high cosine similarity and respects window/practice/self predicates", async () => {
    const p = await practice(t.db);
    const embedded = async (text: string) => embedder.embedText(text);

    const target = await signal(t.db, {
      practiceId: p.id,
      sourceKind: "csv_import",
      sourceId: "row-1",
      occurredAt: when,
      originalText: reviewText,
      originalRating: "5.0",
    });
    const nearDuplicate = await signal(t.db, {
      practiceId: p.id,
      sourceKind: "manual",
      sourceId: "entry-1",
      occurredAt: new Date("2026-05-11T09:00:00Z"), // within ±3 days
      originalText: nearCopyText,
      originalRating: "5.0",
    });
    const unrelated = await signal(t.db, {
      practiceId: p.id,
      sourceKind: "manual",
      sourceId: "entry-2",
      occurredAt: when,
      originalText: unrelatedText,
      originalRating: "5.0",
    });
    const outsideWindow = await signal(t.db, {
      practiceId: p.id,
      sourceKind: "manual",
      sourceId: "entry-3",
      occurredAt: new Date("2026-05-20T10:00:00Z"), // 10 days away
      originalText: nearCopyText,
      originalRating: "5.0",
    });
    const otherPractice = await signal(t.db, {
      sourceKind: "manual",
      sourceId: "entry-4",
      occurredAt: when,
      originalText: nearCopyText,
      originalRating: "5.0",
    });
    const noEmbedding = await signal(t.db, {
      practiceId: p.id,
      sourceKind: "manual",
      sourceId: "entry-5",
      occurredAt: when,
      originalText: nearCopyText,
      originalRating: "5.0",
    });

    // Embed everything except `noEmbedding` (and the target itself, whose
    // embedding rides in as the query parameter).
    await updateSignalEmbedding(
      t.db,
      nearDuplicate.id,
      await embedded(nearCopyText),
    );
    await updateSignalEmbedding(
      t.db,
      unrelated.id,
      await embedded(unrelatedText),
    );
    await updateSignalEmbedding(
      t.db,
      outsideWindow.id,
      await embedded(nearCopyText),
    );
    await updateSignalEmbedding(
      t.db,
      otherPractice.id,
      await embedded(nearCopyText),
    );

    const candidates = await findDuplicateCandidates(t.db, {
      practiceId: p.id,
      excludeSignalId: target.id,
      embedding: await embedded(reviewText),
      occurredAt: when,
      windowDays: 3,
      limit: 5,
    });

    const ids = candidates.map((c) => c.id);
    expect(ids).toContain(nearDuplicate.id);
    expect(ids).not.toContain(target.id); // never its own candidate
    expect(ids).not.toContain(outsideWindow.id); // window predicate
    expect(ids).not.toContain(otherPractice.id); // practice scope
    expect(ids).not.toContain(noEmbedding.id); // needs an embedding

    const hit = candidates.find((c) => c.id === nearDuplicate.id);
    expect(hit?.similarity).toBeGreaterThan(0.92);
    expect(hit?.rating).toBe("5.0");
    expect(hit?.sourceKind).toBe("manual");
    expect(hit?.sourceId).toBe("entry-1");

    const miss = candidates.find((c) => c.id === unrelated.id);
    if (miss) expect(miss.similarity).toBeLessThan(0.92);
  });
});

describe("recordSignalVersion (the exact path's update policy)", () => {
  it("appends a version, moves the pointer, and leaves the immutable originals untouched", async () => {
    const row = await signal(t.db, {
      sourceKind: "manual",
      sourceId: "entry-1",
      occurredAt: when,
      originalText: reviewText,
      originalRating: "5.0",
    });
    await updateSignalEmbedding(
      t.db,
      row.id,
      await embedder.embedText(reviewText),
    );

    const editedText = `${reviewText} EDIT: still thrilled a month later.`;
    const newEmbedding = await embedder.embedText(editedText);
    const version = await t.db.transaction((tx) =>
      recordSignalVersion(tx, {
        signalId: row.id,
        content: editedText,
        rating: "4.0",
        sourceUpdatedAt: null,
        embedding: newEmbedding,
      }),
    );

    const [updated] = await t.db
      .select()
      .from(signals)
      .where(eq(signals.id, row.id));
    // The 0004 trigger would have raised if these had been rewritten.
    expect(updated?.originalText).toBe(reviewText);
    expect(updated?.originalRating).toBe("5.0");
    expect(updated?.currentVersionId).toBe(version.id);
    expect(updated?.pipelineStatus).toBe("pending_classify");
    // pgvector stores float32: compare shape, not exact float64 values.
    expect(updated?.embedding).toHaveLength(newEmbedding.length);

    // Current content resolves to the LATEST version from now on.
    const current = await getSignalWithCurrentContent(t.db, row.id);
    expect(current?.currentText).toBe(editedText);
    expect(current?.currentRating).toBe("4.0");

    // Edit-of-an-edit: a second version supersedes the first.
    const secondText = `${editedText} SECOND EDIT.`;
    const second = await recordSignalVersion(t.db, {
      signalId: row.id,
      content: secondText,
      rating: "4.0",
      sourceUpdatedAt: null,
      embedding: null, // no embedder available: the stale vector clears
    });
    const after = await getSignalWithCurrentContent(t.db, row.id);
    expect(after?.signal.currentVersionId).toBe(second.id);
    expect(after?.currentText).toBe(secondText);
    expect(after?.signal.embedding).toBeNull();

    const versions = await t.db
      .select()
      .from(signalVersions)
      .where(eq(signalVersions.signalId, row.id));
    expect(versions).toHaveLength(2);
  });
});

describe("insertSuspectedDuplicates (no silent merges — links only)", () => {
  it("canonicalizes the pair, is idempotent, and rejects nothing visible", async () => {
    const p = await practice(t.db);
    const a = await signal(t.db, { practiceId: p.id });
    const b = await signal(t.db, { practiceId: p.id });

    const inserted = await insertSuspectedDuplicates(t.db, [
      {
        practiceId: p.id,
        signalIdX: a.id,
        signalIdY: b.id,
        similarity: 0.97,
      },
    ]);
    expect(inserted).toBe(1);

    // Symmetric re-detection (B found A) maps to the same canonical row.
    const again = await insertSuspectedDuplicates(t.db, [
      {
        practiceId: p.id,
        signalIdX: b.id,
        signalIdY: a.id,
        similarity: 0.97,
      },
    ]);
    expect(again).toBe(0);

    const rows = await t.db
      .select()
      .from(suspectedDuplicates)
      .where(eq(suspectedDuplicates.practiceId, p.id));
    expect(rows).toHaveLength(1);
    const expected = canonicalPair(a.id, b.id);
    expect(rows[0]).toMatchObject({
      ...expected,
      status: "pending_review",
      similarity: 0.97,
    });

    // Both signals remain fully visible — linking is the ONLY action.
    const both = await t.db
      .select({ availability: signals.availability })
      .from(signals)
      .where(eq(signals.practiceId, p.id));
    expect(both).toEqual([
      { availability: "available" },
      { availability: "available" },
    ]);
  });
});

describe("getImportRunArtifactKeys", () => {
  it("returns the run's stored keys, and undefined for a missing run", async () => {
    const run = await importRun(t.db, {
      rawArtifactKeys: ["practice/manual/sha256-abc"],
    });
    expect(await getImportRunArtifactKeys(t.db, run.id)).toEqual([
      "practice/manual/sha256-abc",
    ]);
    expect(
      await getImportRunArtifactKeys(
        t.db,
        "00000000-0000-4000-8000-000000000000",
      ),
    ).toBeUndefined();
  });
});

describe("listSuspectedDuplicatesForImportRun (issue #137: report links)", () => {
  it("returns links where either side belongs to the run, with previews", async () => {
    const p = await practice(t.db);
    const oldRun = await importRun(t.db, { practiceId: p.id });
    const newRun = await importRun(t.db, { practiceId: p.id });
    const existing = await signal(t.db, {
      practiceId: p.id,
      importRunId: oldRun.id,
      originalText: "Loved the gentle cleaning.",
      sourceKind: "google",
      sourceId: "reviews/1",
      visibility: "public",
    });
    const imported = await signal(t.db, {
      practiceId: p.id,
      importRunId: newRun.id,
      originalText: "Loved the gentle cleaning!",
    });
    await insertSuspectedDuplicates(t.db, [
      {
        practiceId: p.id,
        signalIdX: existing.id,
        signalIdY: imported.id,
        similarity: 0.97,
      },
    ]);

    const links = await listSuspectedDuplicatesForImportRun(
      t.db,
      p.id,
      newRun.id,
    );
    expect(links).toHaveLength(1);
    const link = links[0];
    const sides = [link?.a, link?.b];
    const fromRun = sides.find((side) => side?.fromThisRun);
    const other = sides.find((side) => !side?.fromThisRun);
    expect(fromRun?.id).toBe(imported.id);
    expect(fromRun?.text).toBe("Loved the gentle cleaning!");
    expect(other?.id).toBe(existing.id);
    expect(other?.sourceKind).toBe("google");
    expect(other?.visibility).toBe("public");
    expect(link?.link.status).toBe("pending_review");

    // The old run sees the same pair from its own perspective.
    const fromOldRun = await listSuspectedDuplicatesForImportRun(
      t.db,
      p.id,
      oldRun.id,
    );
    expect(fromOldRun).toHaveLength(1);

    // Unrelated runs and other practices see nothing.
    const unrelated = await importRun(t.db, { practiceId: p.id });
    expect(
      await listSuspectedDuplicatesForImportRun(t.db, p.id, unrelated.id),
    ).toEqual([]);
    const otherPractice = await practice(t.db);
    expect(
      await listSuspectedDuplicatesForImportRun(
        t.db,
        otherPractice.id,
        newRun.id,
      ),
    ).toEqual([]);
  });
});
