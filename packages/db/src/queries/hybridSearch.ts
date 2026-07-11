/**
 * Hybrid retrieval over `proof_excerpts` (issue #48, Epic #3): cosine ANN
 * (pgvector HNSW) fused with Postgres full-text rank (`ts_rank_cd`) by
 * reciprocal-rank fusion, in one SQL statement.
 *
 * CONSENT GATING IS DELIBERATELY NOT BAKED IN. This helper returns whatever
 * matches — it does not know or care whether an excerpt's parent signal is
 * publishable. Public-facing callers (the Proof API in Epic #14, the proof
 * library in Epic #13) MUST gate results, either by composing a consent
 * join into `filter` or by checking `isPublishable` from
 * `./consents.js` (the single publication gate — see packages/db/CONSENT.md)
 * on each result's `signalId` before anything leaves the building. Internal
 * callers (Epic #16 coverage) legitimately search ungated. If you are
 * returning excerpts to anyone outside the practice and did not gate, that
 * is a bug.
 */

import { type SQL, sql } from "drizzle-orm";

import type { Tx } from "../audit.js";
import type { Db } from "../client.js";
import type { proofExcerpts } from "../schema/proofExcerpts.js";

/** A `proof_excerpts` row. */
export type ProofExcerpt = typeof proofExcerpts.$inferSelect;

export interface HybridSearchParams {
  practiceId: string;
  /**
   * bge-m3 query embedding (length 1024). Omit for a text-only search
   * (e.g. before the embedding job has run, or when the embedding service
   * is down).
   */
  queryEmbedding?: number[];
  /**
   * Full-text query, parsed with `websearch_to_tsquery('english', ...)`.
   * An empty/whitespace-only string skips the FTS branch (vector-only).
   */
  queryText: string;
  /**
   * Composable extra WHERE applied to *both* branches, referencing
   * unaliased `proof_excerpts` columns (e.g. a consent gate join via
   * `EXISTS`, or a topics filter). See the module doc: public-facing
   * callers must gate consent here or after.
   */
  filter?: SQL;
  /** Result count. Default 10. */
  limit?: number;
  /**
   * Per-branch candidate pool. Default 50 — kept well above `limit` so
   * pgvector's post-filtering (practice scope + `filter` are applied during
   * the HNSW scan) does not starve results.
   */
  kCandidates?: number;
  /** Reciprocal-rank-fusion constant. Default 60 (the standard choice). */
  rrfK?: number;
}

export interface HybridSearchResult {
  excerpt: ProofExcerpt;
  /** RRF score: sum over branches of 1 / (rrfK + rank). */
  score: number;
  /** 1-based rank in the cosine ANN branch; null if not in its top-k. */
  vectorRank: number | null;
  /** 1-based rank in the FTS branch; null if not in its top-k. */
  textRank: number | null;
}

const EMBEDDING_DIMENSIONS = 1024;

/**
 * One round trip: each branch ranks its top `kCandidates` rows for the
 * practice (plus `filter`), and the outer query fuses them with
 * `COALESCE(1/(rrfK + vec.rank), 0) + COALESCE(1/(rrfK + kw.rank), 0)`.
 *
 * Degenerate cases: an absent embedding skips the vector branch, an
 * empty/whitespace `queryText` skips the FTS branch, and both absent is a
 * caller error (throws).
 */
export async function hybridSearch(
  db: Db | Tx,
  params: HybridSearchParams,
): Promise<HybridSearchResult[]> {
  const limit = params.limit ?? 10;
  const kCandidates = params.kCandidates ?? 50;
  const rrfK = params.rrfK ?? 60;
  const queryText = params.queryText.trim();
  const hasText = queryText.length > 0;
  const hasEmbedding =
    params.queryEmbedding !== undefined && params.queryEmbedding.length > 0;

  if (!hasText && !hasEmbedding) {
    throw new Error(
      "hybridSearch requires a query embedding, a non-empty query text, or both.",
    );
  }
  if (hasEmbedding && params.queryEmbedding?.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `hybridSearch: queryEmbedding must have ${EMBEDDING_DIMENSIONS} dimensions ` +
        `(bge-m3), got ${params.queryEmbedding?.length}.`,
    );
  }

  // Never interpolate the embedding into SQL text — pass it as a parameter
  // in pgvector's string format and cast.
  const embeddingParam = hasEmbedding
    ? `[${(params.queryEmbedding as number[]).join(",")}]`
    : null;
  const filterClause = params.filter ? sql` AND (${params.filter})` : sql``;

  // An inactive branch becomes an empty relation of the same shape, keeping
  // the statement a single fixed template.
  const vecCte = hasEmbedding
    ? sql`
        SELECT id,
               row_number() OVER (ORDER BY embedding <=> ${embeddingParam}::vector) AS rank
        FROM proof_excerpts
        WHERE practice_id = ${params.practiceId}
          AND embedding IS NOT NULL${filterClause}
        ORDER BY embedding <=> ${embeddingParam}::vector
        LIMIT ${kCandidates}`
    : sql`SELECT NULL::uuid AS id, NULL::bigint AS rank WHERE false`;

  const kwCte = hasText
    ? sql`
        SELECT id,
               row_number() OVER (ORDER BY ts_rank_cd(tsv, q) DESC) AS rank
        FROM proof_excerpts, websearch_to_tsquery('english', ${queryText}) q
        WHERE practice_id = ${params.practiceId}
          AND tsv @@ q${filterClause}
        ORDER BY ts_rank_cd(tsv, q) DESC
        LIMIT ${kCandidates}`
    : sql`SELECT NULL::uuid AS id, NULL::bigint AS rank WHERE false`;

  const result = await db.execute(sql`
    WITH vec AS (${vecCte}),
         kw AS (${kwCte})
    SELECT pe.id,
           pe.signal_id,
           pe.practice_id,
           pe.excerpt_text,
           pe.embedding,
           pe.tsv,
           pe.topics,
           pe.created_at,
           (COALESCE(1.0 / (${rrfK} + vec.rank), 0)
            + COALESCE(1.0 / (${rrfK} + kw.rank), 0))::float8 AS score,
           vec.rank::int AS vector_rank,
           kw.rank::int AS text_rank
    FROM proof_excerpts pe
    LEFT JOIN vec ON vec.id = pe.id
    LEFT JOIN kw ON kw.id = pe.id
    WHERE vec.id IS NOT NULL OR kw.id IS NOT NULL
    ORDER BY score DESC, pe.id
    LIMIT ${limit}
  `);

  // postgres-js returns the row array directly; other drizzle drivers (e.g.
  // PGlite in local verification) return a pg-style `{ rows }` object.
  const rows: unknown[] = Array.isArray(result)
    ? result
    : ((result as unknown as { rows: unknown[] }).rows ?? []);

  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      excerpt: {
        id: r.id as string,
        signalId: r.signal_id as string,
        practiceId: r.practice_id as string,
        excerptText: r.excerpt_text as string,
        // postgres-js has no parser for pgvector's wire format; it arrives
        // as the string "[0.1,0.2,...]", which is valid JSON.
        embedding:
          r.embedding == null
            ? null
            : (JSON.parse(r.embedding as string) as number[]),
        tsv: (r.tsv as string | null) ?? null,
        topics: (r.topics as string[] | null) ?? null,
        createdAt:
          r.created_at instanceof Date
            ? r.created_at
            : new Date(r.created_at as string),
      },
      score: r.score as number,
      vectorRank: (r.vector_rank as number | null) ?? null,
      textRank: (r.text_rank as number | null) ?? null,
    };
  });
}
