import { afterAll, describe, expect, it } from "vitest";

import { createDb } from "../client.js";
import {
  currentDerivationsQuery,
  getCurrentDerivationsForSignals,
} from "./derivations.js";

/**
 * Unit tests for the current-derivation resolution (issue #36).
 *
 * The resolution rule lives in the SQL of `currentDerivationsQuery`; these
 * tests pin its shape — `DISTINCT ON` with manual-outranks-inferred ordering
 * — without a database (postgres-js connects lazily, so building the query
 * and rendering it is safe offline). The behavior against real rows is
 * proven in derivations.integration.test.ts.
 */
const { db, sql } = createDb("postgres://unit:unit@localhost:5432/unit");

afterAll(async () => {
  await sql.end();
});

describe("currentDerivationsQuery (unit)", () => {
  const rendered = currentDerivationsQuery(db, ["a", "b"]).toSQL();
  const query = rendered.sql.toLowerCase();

  it("selects one row per (signal_id, dimension) via DISTINCT ON", () => {
    expect(query).toContain(
      'distinct on ("derivations"."signal_id", "derivations"."dimension")',
    );
  });

  it("orders manual rows above inferred ones, then by recency — a human correction is never overridden by a newer model run", () => {
    const orderBy = query.slice(query.indexOf("order by"));
    // Exactly the issue's ordering:
    //   dimension, (basis = 'manual') DESC, created_at DESC
    // (prefixed by signal_id for the multi-signal variant).
    const manualFirst = orderBy.indexOf(
      '("derivations"."basis" = \'manual\') desc',
    );
    const recency = orderBy.indexOf('"derivations"."created_at" desc');
    expect(manualFirst).toBeGreaterThan(-1);
    expect(recency).toBeGreaterThan(-1);
    expect(manualFirst).toBeLessThan(recency);
    expect(orderBy.indexOf('"derivations"."dimension"')).toBeLessThan(
      manualFirst,
    );
  });

  it("parameterizes the signal ids", () => {
    expect(rendered.params).toEqual(["a", "b"]);
  });
});

describe("getCurrentDerivationsForSignals (unit)", () => {
  it("returns an all-undefined record per signal for an empty id list without querying", async () => {
    // No DB behind this client — reaching the query would throw.
    const result = await getCurrentDerivationsForSignals(db, []);
    expect(result).toEqual({});
  });
});
