import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { aiCalls } from "./aiCalls.js";

function column(name: string) {
  return getTableConfig(aiCalls).columns.find((c) => c.name === name);
}

describe("ai_calls schema (unit)", () => {
  it("exposes the table under its SQL name", () => {
    expect(getTableName(aiCalls)).toBe("ai_calls");
  });

  it("keeps practice_id nullable — tenant-less calls (evals, backfills) are legal", () => {
    expect(column("practice_id")?.notNull).toBe(false);
  });

  it("requires the cost columns", () => {
    for (const name of [
      "purpose",
      "model",
      "input_tokens",
      "output_tokens",
      "latency_ms",
      "created_at",
    ]) {
      expect(column(name)?.notNull, `${name} should be NOT NULL`).toBe(true);
    }
  });

  it("keeps error nullable — null means the call was clean", () => {
    expect(column("error")?.notNull).toBe(false);
  });

  it("has no updated_at — rows are append-only cost telemetry", () => {
    expect(column("updated_at")).toBeUndefined();
  });
});
