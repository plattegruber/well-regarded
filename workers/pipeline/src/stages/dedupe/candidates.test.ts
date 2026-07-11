import { describe, expect, it } from "vitest";

import {
  hasEmbeddableText,
  isSameSourceIdentity,
  isSuspectedDuplicate,
  ratingsMatch,
} from "./candidates";

const google = {
  rating: "5.0",
  sourceKind: "google" as const,
  sourceId: "review-1",
};
const csv = {
  rating: "5.0",
  sourceKind: "csv_import" as const,
  sourceId: "row-9",
};

describe("ratingsMatch", () => {
  it("matches equal canonical ratings", () => {
    expect(ratingsMatch("5.0", "5.0")).toBe(true);
  });

  it("rejects different ratings", () => {
    expect(ratingsMatch("5.0", "4.0")).toBe(false);
  });

  it("null ratings never match — not even each other", () => {
    expect(ratingsMatch(null, "5.0")).toBe(false);
    expect(ratingsMatch("5.0", null)).toBe(false);
    expect(ratingsMatch(null, null)).toBe(false);
  });
});

describe("isSameSourceIdentity", () => {
  it("same kind + same non-null id is the exact path's territory", () => {
    expect(isSameSourceIdentity(google, { ...google })).toBe(true);
  });

  it("different kinds are cross-source", () => {
    expect(isSameSourceIdentity(google, csv)).toBe(false);
  });

  it("same kind, different ids are distinct signals", () => {
    expect(
      isSameSourceIdentity(google, { ...google, sourceId: "review-2" }),
    ).toBe(false);
  });

  it("two null source ids are NOT the same identity (manual entries)", () => {
    const manualA = {
      rating: "5.0",
      sourceKind: "manual" as const,
      sourceId: null,
    };
    expect(isSameSourceIdentity(manualA, { ...manualA })).toBe(false);
  });
});

describe("isSuspectedDuplicate", () => {
  const threshold = 0.92;

  it("links a cross-source candidate above the threshold with equal rating", () => {
    expect(
      isSuspectedDuplicate({ ...csv, similarity: 0.97 }, google, threshold),
    ).toBe(true);
  });

  it("the threshold is strict: exactly 0.92 is not a hit", () => {
    expect(
      isSuspectedDuplicate(
        { ...csv, similarity: threshold },
        google,
        threshold,
      ),
    ).toBe(false);
  });

  it("rejects below-threshold similarity", () => {
    expect(
      isSuspectedDuplicate({ ...csv, similarity: 0.9 }, google, threshold),
    ).toBe(false);
  });

  it("rejects rating mismatches, and null ratings never match", () => {
    expect(
      isSuspectedDuplicate(
        { ...csv, rating: "4.0", similarity: 0.99 },
        google,
        threshold,
      ),
    ).toBe(false);
    expect(
      isSuspectedDuplicate(
        { ...csv, rating: null, similarity: 0.99 },
        { ...google, rating: null },
        threshold,
      ),
    ).toBe(false);
  });

  it("never links the same source identity (that is the exact path)", () => {
    expect(
      isSuspectedDuplicate({ ...google, similarity: 0.99 }, google, threshold),
    ).toBe(false);
  });
});

describe("hasEmbeddableText", () => {
  it("accepts real text and rejects null/empty/whitespace", () => {
    expect(hasEmbeddableText("Great visit")).toBe(true);
    expect(hasEmbeddableText(null)).toBe(false);
    expect(hasEmbeddableText(undefined)).toBe(false);
    expect(hasEmbeddableText("")).toBe(false);
    expect(hasEmbeddableText("   ")).toBe(false);
  });
});
