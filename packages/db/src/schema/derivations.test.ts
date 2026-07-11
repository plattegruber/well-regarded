import { DERIVATION_BASES, DERIVATION_DIMENSIONS } from "@wellregarded/core";
import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  derivationBasisEnum,
  derivationDimensionEnum,
  derivations,
} from "./derivations.js";

describe("derivations schema (unit)", () => {
  it("derives both enums from the core constants", () => {
    expect(derivationDimensionEnum.enumName).toBe("derivation_dimension");
    expect(derivationDimensionEnum.enumValues).toEqual([
      ...DERIVATION_DIMENSIONS,
    ]);
    expect(derivationBasisEnum.enumName).toBe("derivation_basis");
    expect(derivationBasisEnum.enumValues).toEqual([...DERIVATION_BASES]);
  });

  it("exposes the derivations table under its SQL name", () => {
    expect(getTableName(derivations)).toBe("derivations");
  });

  it("has no updated_at column — append-only is the convention", () => {
    // Rows are never updated in place; a new row supersedes the old. The
    // absence of updated_at IS the convention (issue #36).
    expect("updatedAt" in derivations).toBe(false);
  });
});
