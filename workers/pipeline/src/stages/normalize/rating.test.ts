import { describe, expect, it } from "vitest";

import { canonicalizeRating } from "./rating";

describe("canonicalizeRating", () => {
  it("keeps the value on the source's own scale, one decimal", () => {
    expect(canonicalizeRating({ value: 4, scale: 5 })).toBe("4.0");
    expect(canonicalizeRating({ value: 4.5, scale: 5 })).toBe("4.5");
    expect(canonicalizeRating({ value: 9, scale: 10 })).toBe("9.0");
  });

  it("passes null through (rating-less sources exist)", () => {
    expect(canonicalizeRating(null)).toBeNull();
  });

  it("refuses values numeric(2,1) cannot hold instead of truncating", () => {
    expect(() => canonicalizeRating({ value: 10, scale: 10 })).toThrow(
      "does not fit original_rating",
    );
  });
});
