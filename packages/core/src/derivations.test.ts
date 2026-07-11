/**
 * Urgency-ordering tests (issue #108): the route stage's threshold
 * comparison must follow the vocabulary's declared order, never string
 * comparison (which would sort "critical" below "high" alphabetically).
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_URGENCY_ROUTING_THRESHOLD,
  isUrgencyLevel,
  meetsUrgencyThreshold,
  URGENCY_LEVELS,
  urgencyRank,
} from "./derivations.js";

describe("urgencyRank", () => {
  it("ranks strictly in declared order", () => {
    const ranks = URGENCY_LEVELS.map(urgencyRank);
    expect(ranks).toEqual([0, 1, 2, 3, 4]);
  });

  it("is not alphabetical ordering (critical outranks high)", () => {
    expect(urgencyRank("critical")).toBeGreaterThan(urgencyRank("high"));
    // The string comparison this helper exists to prevent:
    expect("critical" < "high").toBe(true);
  });
});

describe("meetsUrgencyThreshold", () => {
  it("fires at exactly the threshold (boundary case from #108)", () => {
    expect(meetsUrgencyThreshold("high", "high")).toBe(true);
  });

  it("fires above and not below the threshold", () => {
    expect(meetsUrgencyThreshold("critical", "high")).toBe(true);
    expect(meetsUrgencyThreshold("medium", "high")).toBe(false);
    expect(meetsUrgencyThreshold("none", "low")).toBe(false);
  });

  it("respects a raised threshold (critical-only practice)", () => {
    expect(meetsUrgencyThreshold("high", "critical")).toBe(false);
    expect(meetsUrgencyThreshold("critical", "critical")).toBe(true);
  });

  it("defaults to high per issue #108", () => {
    expect(DEFAULT_URGENCY_ROUTING_THRESHOLD).toBe("high");
  });
});

describe("isUrgencyLevel", () => {
  it("accepts every vocabulary value and rejects everything else", () => {
    for (const level of URGENCY_LEVELS) {
      expect(isUrgencyLevel(level)).toBe(true);
    }
    expect(isUrgencyLevel("urgent")).toBe(false);
    expect(isUrgencyLevel(3)).toBe(false);
    expect(isUrgencyLevel(null)).toBe(false);
  });
});
