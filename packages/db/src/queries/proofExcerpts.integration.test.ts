/**
 * proof_excerpts write path + backfill queries against real Postgres
 * (issues #69/#71): idempotency probe, atomic multi-row insert with
 * offsets, embedding updates with the model stamped, and the
 * needs-embedding batch query (WHERE clause + practice scope + keyset
 * cursor). The full backfill loop runs in
 * workers/jobs/test/embeddingBackfill.integration.test.ts.
 */

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { practice, proofExcerpt, signal } from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import { proofExcerpts } from "../schema/proofExcerpts.js";
import {
  excerptsNeedingEmbedding,
  insertProofExcerpts,
  setProofExcerptEmbeddings,
  signalHasProofExcerpts,
} from "./proofExcerpts.js";

const DIMS = 1024;

function vec(weight: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[0] = weight;
  return v;
}

describe("proof_excerpts queries (integration)", () => {
  const t = setupTestDb();

  it("inserts excerpt rows with offsets and probes idempotently", async () => {
    const parent = await signal(t.db, { originalText: "Care. Billing." });

    expect(await signalHasProofExcerpts(t.db, parent.id)).toBe(false);

    const rows = await insertProofExcerpts(t.db, [
      {
        signalId: parent.id,
        practiceId: parent.practiceId,
        excerptText: "Care.",
        startOffset: 0,
        topicHint: "care",
      },
      {
        signalId: parent.id,
        practiceId: parent.practiceId,
        excerptText: "Billing.",
        startOffset: 6,
        topicHint: "billing",
      },
    ]);

    expect(rows).toHaveLength(2);
    // Embedding NULL until the inline pass / backfill; model default set.
    for (const row of rows) {
      expect(row.embedding).toBeNull();
      expect(row.embeddingModel).toBe("@cf/baai/bge-m3");
    }
    expect(rows.map((row) => row.startOffset)).toEqual([0, 6]);
    expect(await signalHasProofExcerpts(t.db, parent.id)).toBe(true);
  });

  it("fills embeddings and stamps the producing model", async () => {
    const row = await proofExcerpt(t.db, { embedding: null });

    await setProofExcerptEmbeddings(t.db, [
      { id: row.id, embedding: vec(1), embeddingModel: "fake-bge-m3" },
    ]);

    const [updated] = await t.db
      .select()
      .from(proofExcerpts)
      .where(eq(proofExcerpts.id, row.id));
    expect(updated?.embedding?.[0]).toBe(1);
    expect(updated?.embedding).toHaveLength(DIMS);
    expect(updated?.embeddingModel).toBe("fake-bge-m3");
  });

  it("selects rows needing embedding: NULL or wrong model, practice-scoped, id-ordered with a keyset cursor", async () => {
    const mine = await practice(t.db);
    const other = await practice(t.db);
    const parent = await signal(t.db, { practiceId: mine.id });

    const nullRow = await proofExcerpt(t.db, {
      practiceId: mine.id,
      signalId: parent.id,
      embedding: null,
    });
    const staleModelRow = await proofExcerpt(t.db, {
      practiceId: mine.id,
      signalId: parent.id,
      embedding: vec(1),
      embeddingModel: "old-model",
    });
    // Already current: must NOT match.
    await proofExcerpt(t.db, {
      practiceId: mine.id,
      signalId: parent.id,
      embedding: vec(0.5),
      embeddingModel: "fake-bge-m3",
    });
    // Another practice's row: excluded by the scope.
    await proofExcerpt(t.db, { practiceId: other.id, embedding: null });

    const all = await excerptsNeedingEmbedding(t.db, {
      targetModel: "fake-bge-m3",
      practiceId: mine.id,
      limit: 10,
    });
    expect(all.map((row) => row.id).sort()).toEqual(
      [nullRow.id, staleModelRow.id].sort(),
    );
    // Stable id order for keyset pagination.
    expect(all.map((row) => row.id)).toEqual(
      [...all.map((row) => row.id)].sort(),
    );

    // Cursor: everything after the first id, limit respected.
    const firstId = all[0]?.id as string;
    const rest = await excerptsNeedingEmbedding(t.db, {
      targetModel: "fake-bge-m3",
      practiceId: mine.id,
      afterId: firstId,
      limit: 10,
    });
    expect(rest.map((row) => row.id)).toEqual(
      all.slice(1).map((row) => row.id),
    );

    const limited = await excerptsNeedingEmbedding(t.db, {
      targetModel: "fake-bge-m3",
      practiceId: mine.id,
      limit: 1,
    });
    expect(limited).toHaveLength(1);
    expect(limited[0]?.id).toBe(all[0]?.id);
  });
});
