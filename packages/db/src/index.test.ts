import { describe, expect, it } from "vitest";

import { createDb } from "./index.js";

describe("createDb", () => {
  it("returns a drizzle db and the raw postgres-js client without connecting", async () => {
    // postgres-js connects lazily, so constructing a client is safe offline.
    const { db, sql } = createDb(
      "postgres://user:pass@localhost:5432/nonexistent",
    );

    expect(db).toBeDefined();
    expect(typeof db.execute).toBe("function");
    expect(typeof sql).toBe("function");
    expect(typeof sql.end).toBe("function");

    // prepare: false and max: 5 defaults (Hyperdrive-safe settings).
    expect(sql.options.prepare).toBe(false);
    expect(sql.options.max).toBe(5);

    await sql.end();
  });

  it("lets callers override the pool size", async () => {
    const { sql } = createDb("postgres://user:pass@localhost:5432/whatever", {
      max: 1,
    });
    expect(sql.options.max).toBe(1);
    await sql.end();
  });
});
