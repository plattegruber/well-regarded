/**
 * `proof_excerpts` — aspect-level slices with embeddings (issue #48,
 * Epic #3).
 *
 * Search and Trust Coverage are geometric: multi-topic reviews are split
 * into aspect-level excerpts, each with its own embedding, and retrieval is
 * hybrid — vector similarity fused with Postgres full-text rank (see
 * `hybridSearch` in `../queries/hybridSearch.js`). Epic #9 (embeddings
 * write path), Epic #14 (Proof API), and Epic #16 (coverage) all build on
 * this table.
 *
 * - `embedding vector(1024)` hard-codes bge-m3 dimensionality (Workers AI
 *   `@cf/baai/bge-m3`). Embeddings are swappable in principle — a different
 *   model with different dims is a migration (new column + backfill), which
 *   is fine; no multi-dim over-engineering now. Nullable because excerpt
 *   rows are written before the embedding job fills them in.
 * - `tsv` is a stored generated column (`to_tsvector('english', ...)`), so
 *   the FTS branch of hybrid search never drifts from the text.
 * - `practice_id` is denormalized on purpose: pgvector applies non-vector
 *   predicates as post-filters during the HNSW scan, which works acceptably
 *   as a cheap same-row check but terribly through a join.
 *
 * Indexes (HNSW `vector_cosine_ops` on `embedding`, GIN on `tsv`) are in
 * the generated migration; HNSW on an empty table is instant and stays
 * correct as rows arrive — no create-after-backfill dance at our scale.
 */

import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import { signals } from "./signals.js";
import { practices } from "./tenancy.js";

/**
 * Postgres `tsvector`, which drizzle-orm has no built-in column type for.
 * Only ever read/written by Postgres itself (generated column + GIN index);
 * the string data type exists for row-type completeness.
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const proofExcerpts = pgTable(
  "proof_excerpts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    /** Denormalized for HNSW post-filtering — see module doc. */
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    /**
     * The aspect-level slice of the parent signal's original text —
     * ALWAYS verbatim: `original_text.slice(start_offset, start_offset +
     * excerpt_text.length) === excerpt_text` (enforced server-side by the
     * extraction pass, issue #69; a fabricated quote is never stored).
     */
    excerptText: text("excerpt_text").notNull(),
    /**
     * Character offset of `excerpt_text` in the parent signal's
     * `original_text` (issue #69). Nullable: rows written before the
     * extraction pass existed (seed data) have no recorded offset.
     */
    startOffset: integer("start_offset"),
    /**
     * Free-text aspect label from the extraction pass, for debugging and
     * evals only (issue #69) — topics are emergent via embeddings, never
     * an enum. Null for whole-text fallback rows and pre-extraction rows.
     */
    topicHint: text("topic_hint"),
    /** bge-m3 embedding; null until the embedding job (Epic #9) fills it. */
    embedding: vector("embedding", { dimensions: 1024 }),
    /**
     * Which model produced `embedding` (issue #71) — set alongside the
     * vector; the default documents the current model for rows whose
     * embedding is still NULL. A future model migration is a re-embed job
     * filtering `WHERE embedding IS NULL OR embedding_model != $current`.
     */
    embeddingModel: text("embedding_model")
      .notNull()
      .default("@cf/baai/bge-m3"),
    tsv: tsvector("tsv").generatedAlwaysAs(
      (): ReturnType<typeof sql> => sql`to_tsvector('english', "excerpt_text")`,
    ),
    /**
     * Emergent topic hints from clustering (Epic #9) — free text, no enum,
     * no taxonomy.
     */
    topics: text("topics").array(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("proof_excerpts_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    index("proof_excerpts_tsv_gin_idx").using("gin", table.tsv),
    index("proof_excerpts_practice_id_idx").on(table.practiceId),
    index("proof_excerpts_signal_id_idx").on(table.signalId),
  ],
);
