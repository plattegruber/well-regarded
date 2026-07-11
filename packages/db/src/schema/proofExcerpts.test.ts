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

  it("declares tsv as a stored generated tsvector column", () => {
    const tsv = getTableConfig(proofExcerpts).columns.find(
      (column) => column.name === "tsv",
    );
    expect(tsv?.getSQLType()).toBe("tsvector");
    expect(tsv?.generated).toBeDefined();
  });
});
