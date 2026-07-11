import { ne, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { practice, proofExcerpt, signal } from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import { proofExcerpts } from "../schema/proofExcerpts.js";
import { hybridSearch } from "./hybridSearch.js";

/**
 * Integration tests for proof_excerpts and hybridSearch (migration 0007,
 * issue #48) against a real Postgres with pgvector, on the #49 harness
 * (own database per file, factories for fixtures, no cleanup needed).
 *
 * Real embeddings are not available in tests, so we seed synthetic
 * 1024-dim vectors constructed to have known cosine ordering:
 * basis-vector perturbations around axis 0 (the "query direction").
 *
 * Run locally with:
 *
 *   docker compose up -d && pnpm --filter @wellregarded/db test:integration
 */

const DIMS = 1024;

/**
 * A 1024-dim vector: `weight` along axis 0 plus `offAxis` along a second
 * axis. Cosine similarity to the query direction (pure axis 0) decreases as
 * `offAxis` grows relative to `weight`.
 */
function vec(weight: number, offAxis = 0, axis = 1): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[0] = weight;
  if (offAxis !== 0) v[axis] = offAxis;
  return v;
}

/** The query embedding: the pure axis-0 direction. */
const queryEmbedding = vec(1);

describe("proof_excerpts + hybridSearch (integration)", () => {
  const t = setupTestDb();
  let practiceId: string;
  let otherPracticeId: string;

  /** Excerpt ids by fixture name, for assertions. */
  const ids: Record<string, string> = {};

  async function insertExcerpt(
    name: string,
    pid: string,
    signalId: string,
    excerptText: string,
    embedding: number[] | null,
  ) {
    const row = await proofExcerpt(t.db, {
      practiceId: pid,
      signalId,
      excerptText,
      embedding,
    });
    ids[name] = row.id;
    return row;
  }

  beforeAll(async () => {
    practiceId = (await practice(t.db)).id;
    otherPracticeId = (await practice(t.db)).id;
    const parent = await signal(t.db, {
      practiceId,
      sourceKind: "google",
      sourceId: "reviews/hybrid/parent",
      occurredAt: new Date("2026-06-01T00:00:00Z"),
      originalText: "Parent review text.",
      visibility: "public",
    });
    const foreignParent = await signal(t.db, {
      practiceId: otherPracticeId,
      sourceKind: "google",
      sourceId: "reviews/hybrid/foreign-parent",
      occurredAt: new Date("2026-06-01T00:00:00Z"),
      originalText: "Parent review text.",
      visibility: "public",
    });

    // Vector branch ordering (cosine sim to queryEmbedding, descending):
    //   vecTop (1.0) > fusionMid (~0.89) > textTop (~0.45) > vecFar (0.0)
    // Text branch ordering for "sedation anxiety" (ts_rank_cd, descending):
    //   textTop (dense repeats) > fusionMid (one mention each) — vecTop and
    //   vecFar do not match at all.
    await insertExcerpt(
      "vecTop",
      practiceId,
      parent.id,
      "The parking situation out front was easy and spacious.",
      vec(1), // identical direction to the query: vector rank 1
    );
    await insertExcerpt(
      "fusionMid",
      practiceId,
      parent.id,
      "The sedation option kept my anxiety manageable during the visit.",
      vec(1, 0.5), // close but not closest: vector rank 2
    );
    await insertExcerpt(
      "textTop",
      practiceId,
      parent.id,
      "Sedation, sedation, sedation — anxiety about anxiety, and sedation again.",
      vec(1, 2), // far-ish: vector rank 3
    );
    await insertExcerpt(
      "vecFar",
      practiceId,
      parent.id,
      "Billing was straightforward and the front desk was kind.",
      vec(0, 1), // orthogonal to the query: vector rank 4
    );
    await insertExcerpt(
      "noEmbedding",
      practiceId,
      parent.id,
      "An excerpt still waiting for the embedding job.",
      null,
    );
    // Other-practice row that would top both branches if scoping leaked.
    await insertExcerpt(
      "foreign",
      otherPracticeId,
      foreignParent.id,
      "Sedation anxiety sedation anxiety — the perfect match.",
      vec(1),
    );
  });

  it("populates the generated tsv column on insert", async () => {
    const [row] = await t.db
      .select()
      .from(proofExcerpts)
      .where(sql`${proofExcerpts.id} = ${ids.fusionMid}`);
    expect(row?.tsv).toBeTruthy();
    expect(row?.tsv).toContain("sedat"); // english stemmer lexeme
  });

  it("vector-only (empty queryText): near vectors rank above far ones", async () => {
    const results = await hybridSearch(t.db, {
      practiceId,
      queryEmbedding,
      queryText: "   ",
    });
    const orderedIds = results.map((r) => r.excerpt.id);
    expect(orderedIds.indexOf(ids.vecTop as string)).toBeLessThan(
      orderedIds.indexOf(ids.fusionMid as string),
    );
    expect(orderedIds.indexOf(ids.fusionMid as string)).toBeLessThan(
      orderedIds.indexOf(ids.vecFar as string),
    );
    // FTS branch skipped: no result carries a text rank.
    expect(results.every((r) => r.textRank === null)).toBe(true);
    expect(results[0]?.vectorRank).toBe(1);
    // Rows without an embedding never appear in a vector-only search.
    expect(orderedIds).not.toContain(ids.noEmbedding as string);
  });

  it("text-only (no embedding): websearch_to_tsquery handles multi-word queries", async () => {
    const results = await hybridSearch(t.db, {
      practiceId,
      queryText: "sedation anxiety",
    });
    const orderedIds = results.map((r) => r.excerpt.id);
    expect(orderedIds).toContain(ids.textTop as string);
    expect(orderedIds).toContain(ids.fusionMid as string);
    expect(orderedIds).not.toContain(ids.vecTop as string); // no text match
    expect(orderedIds.indexOf(ids.textTop as string)).toBeLessThan(
      orderedIds.indexOf(ids.fusionMid as string),
    );
    expect(results.every((r) => r.vectorRank === null)).toBe(true);
  });

  it("fusion: mid-pack-in-both outscores top-of-one-branch-only at the default rrfK", async () => {
    const results = await hybridSearch(t.db, {
      practiceId,
      queryEmbedding,
      queryText: "sedation anxiety",
    });
    const byId = new Map(results.map((r) => [r.excerpt.id, r]));

    // fusionMid: rank 2 in the vector branch AND rank 2 in the text branch.
    const mid = byId.get(ids.fusionMid as string);
    expect(mid?.vectorRank).toBe(2);
    expect(mid?.textRank).toBe(2);

    // vecTop: rank 1 in the vector branch, absent from the text branch.
    const oneBranch = byId.get(ids.vecTop as string);
    expect(oneBranch?.vectorRank).toBe(1);
    expect(oneBranch?.textRank).toBeNull();

    // 1/(60+2) + 1/(60+2) > 1/(60+1): fused presence beats single-branch
    // dominance.
    expect(mid?.score).toBeGreaterThan(oneBranch?.score ?? Number.NaN);
    expect(
      results.findIndex((r) => r.excerpt.id === ids.fusionMid),
    ).toBeLessThan(results.findIndex((r) => r.excerpt.id === ids.vecTop));

    // Scores are the RRF sums they claim to be.
    expect(mid?.score).toBeCloseTo(1 / 62 + 1 / 62, 10);
    expect(oneBranch?.score).toBeCloseTo(1 / 61, 10);
  });

  it("never returns other practices' excerpts", async () => {
    const results = await hybridSearch(t.db, {
      practiceId,
      queryEmbedding,
      queryText: "sedation anxiety",
      kCandidates: 100,
      limit: 100,
    });
    expect(results.map((r) => r.excerpt.id)).not.toContain(
      ids.foreign as string,
    );
    for (const r of results) {
      expect(r.excerpt.practiceId).toBe(practiceId);
    }
  });

  it("composes a caller filter into both branches", async () => {
    // The consent-gate shape: callers pass extra WHERE on proof_excerpts.
    const results = await hybridSearch(t.db, {
      practiceId,
      queryEmbedding,
      queryText: "sedation anxiety",
      filter: ne(proofExcerpts.id, ids.fusionMid as string),
    });
    const orderedIds = results.map((r) => r.excerpt.id);
    // fusionMid was in both branches; the filter removes it from both.
    expect(orderedIds).not.toContain(ids.fusionMid as string);
    expect(orderedIds).toContain(ids.vecTop as string);
    expect(orderedIds).toContain(ids.textTop as string);
  });

  it("respects limit and returns mapped row shapes", async () => {
    const results = await hybridSearch(t.db, {
      practiceId,
      queryEmbedding,
      queryText: "sedation anxiety",
      limit: 2,
    });
    expect(results).toHaveLength(2);
    const first = results[0];
    if (!first) throw new Error("expected a result");
    expect(first.excerpt.createdAt).toBeInstanceOf(Date);
    expect(typeof first.excerpt.excerptText).toBe("string");
    expect(Array.isArray(first.excerpt.embedding)).toBe(true);
    expect(first.excerpt.embedding).toHaveLength(DIMS);
    expect(typeof first.score).toBe("number");
  });

  it("throws when both the embedding and the query text are absent", async () => {
    await expect(
      hybridSearch(t.db, { practiceId, queryText: "  " }),
    ).rejects.toThrow(/query embedding, a non-empty query text, or both/);
  });

  it("throws on a wrong-dimension embedding", async () => {
    await expect(
      hybridSearch(t.db, {
        practiceId,
        queryEmbedding: [1, 2, 3],
        queryText: "",
      }),
    ).rejects.toThrow(/1024 dimensions/);
  });

  it("uses the HNSW and GIN indexes it shipped (sanity check via pg_indexes)", async () => {
    const rows = await t.db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'proof_excerpts'
    `);
    const defs = [...rows].map(
      (r) => (r as Record<string, unknown>).indexdef as string,
    );
    expect(
      defs.some(
        (d) => d.includes("USING hnsw") && d.includes("vector_cosine_ops"),
      ),
    ).toBe(true);
    expect(defs.some((d) => d.includes("USING gin") && d.includes("tsv"))).toBe(
      true,
    );
  });
});
