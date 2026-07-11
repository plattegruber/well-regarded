import {
  RETENTION_STATES,
  SIGNAL_AVAILABILITIES,
  SIGNAL_VISIBILITIES,
  SOURCE_KINDS,
} from "@wellregarded/core";
import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  retentionStateEnum,
  signalAvailabilityEnum,
  signals,
  signalVisibilityEnum,
  sourceKindEnum,
} from "./signals.js";

describe("signals schema (unit)", () => {
  it("derives all four enums from the core constants", () => {
    // One source of truth: the pgEnums must track @wellregarded/core exactly
    // (the Epic #8 source adapters consume the same constants).
    expect(sourceKindEnum.enumName).toBe("source_kind");
    expect(sourceKindEnum.enumValues).toEqual([...SOURCE_KINDS]);
    expect(signalVisibilityEnum.enumName).toBe("signal_visibility");
    expect(signalVisibilityEnum.enumValues).toEqual([...SIGNAL_VISIBILITIES]);
    expect(signalAvailabilityEnum.enumName).toBe("signal_availability");
    expect(signalAvailabilityEnum.enumValues).toEqual([
      ...SIGNAL_AVAILABILITIES,
    ]);
    expect(retentionStateEnum.enumName).toBe("retention_state");
    expect(retentionStateEnum.enumValues).toEqual([...RETENTION_STATES]);
  });

  it("exposes the signals table under its SQL name", () => {
    expect(getTableName(signals)).toBe("signals");
  });

  it("has no derived/publishability columns (they belong to derivations/consents)", () => {
    const columnNames = Object.values(signals)
      .filter(
        (column): column is { name: string } =>
          typeof column === "object" &&
          column !== null &&
          "name" in column &&
          typeof column.name === "string",
      )
      .map((column) => column.name);
    // Ethical invariants: no sentiment/status here (that is derivations),
    // and no publishability flag ever (see CONSENT.md).
    expect(columnNames).not.toContain("sentiment");
    expect(columnNames).not.toContain("status");
    expect(columnNames).not.toContain("is_publishable");
    expect(columnNames).not.toContain("published");
  });
});
