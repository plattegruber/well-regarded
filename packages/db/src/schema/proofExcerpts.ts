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
    /** The aspect-level slice of the parent signal's original text. */
    excerptText: text("excerpt_text").notNull(),
    /** bge-m3 embedding; null until the embedding job (Epic #9) fills it. */
    embedding: vector("embedding", { dimensions: 1024 }),
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
