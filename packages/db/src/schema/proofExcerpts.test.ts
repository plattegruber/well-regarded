import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { proofExcerpts } from "./proofExcerpts.js";

describe("proof_excerpts schema (unit)", () => {
  it("exposes the table under its SQL name", () => {
    expect(getTableName(proofExcerpts)).toBe("proof_excerpts");
  });

  it("hard-codes bge-m3 dimensionality on the embedding column", () => {
    // vector(1024) — a different embedding model with different dims is a
    // migration (new column + backfill), not runtime configuration.
    const embedding = getTableConfig(proofExcerpts).columns.find(
      (column) => column.name === "embedding",
    );
    expect(embedding?.getSQLType()).toBe("vector(1024)");
    // Nullable on purpose: rows are written before the embedding job runs.
    expect(embedding?.notNull).toBe(false);
  });

  it("records which model produced each embedding (issue #71)", () => {
    const embeddingModel = getTableConfig(proofExcerpts).columns.find(
      (column) => column.name === "embedding_model",
    );
    expect(embeddingModel?.notNull).toBe(true);
    expect(embeddingModel?.default).toBe("@cf/baai/bge-m3");
  });

  it("keeps start_offset and topic_hint nullable for pre-extraction rows (issue #69)", () => {
    const columns = getTableConfig(proofExcerpts).columns;
    const startOffset = columns.find(
      (column) => column.name === "start_offset",
    );
    const topicHint = columns.find((column) => column.name === "topic_hint");
    expect(startOffset?.getSQLType()).toBe("integer");
    expect(startOffset?.notNull).toBe(false);
    expect(topicHint?.notNull).toBe(false);
  });

  it("declares tsv as a stored generated tsvector column", () => {
    const tsv = getTableConfig(proofExcerpts).columns.find(
      (column) => column.name === "tsv",
    );
    expect(tsv?.getSQLType()).toBe("tsvector");
    expect(tsv?.generated).toBeDefined();
  });
});
