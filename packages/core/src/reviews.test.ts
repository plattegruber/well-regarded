import { describe, expect, it } from "vitest";

import {
  isNegativeReview,
  isReviewSourceKind,
  REVIEW_SOURCE_KINDS,
  reviewStatusFromResponseState,
} from "./reviews.js";
import { SOURCE_KINDS } from "./signals.js";

describe("REVIEW_SOURCE_KINDS", () => {
  it("is a strict subset of SOURCE_KINDS", () => {
    for (const kind of REVIEW_SOURCE_KINDS) {
      expect(SOURCE_KINDS).toContain(kind);
    }
    expect(REVIEW_SOURCE_KINDS.length).toBeLessThan(SOURCE_KINDS.length);
  });

  it("classifies review vs non-review kinds", () => {
    expect(isReviewSourceKind("google")).toBe(true);
    expect(isReviewSourceKind("csv_import")).toBe(true);
    expect(isReviewSourceKind("manual")).toBe(true);
    expect(isReviewSourceKind("email")).toBe(false);
    expect(isReviewSourceKind("firstparty")).toBe(false);
    expect(isReviewSourceKind("opendental")).toBe(false);
  });
});

describe("reviewStatusFromResponseState", () => {
  it("maps no response row to needs_response (the documented fallback)", () => {
    expect(reviewStatusFromResponseState(null)).toBe("needs_response");
    expect(reviewStatusFromResponseState(undefined)).toBe("needs_response");
  });

  it("maps draft to drafted", () => {
    expect(reviewStatusFromResponseState("draft")).toBe("drafted");
  });

  it("keeps the whole human gate under pending_approval", () => {
    expect(reviewStatusFromResponseState("pending_approval")).toBe(
      "pending_approval",
    );
    expect(reviewStatusFromResponseState("approved")).toBe("pending_approval");
    expect(reviewStatusFromResponseState("failed")).toBe("pending_approval");
  });

  it("maps only published to responded", () => {
    expect(reviewStatusFromResponseState("published")).toBe("responded");
  });

  it("reads an unknown status conservatively as drafted", () => {
    expect(reviewStatusFromResponseState("weird_future_state")).toBe("drafted");
  });
});

describe("isNegativeReview", () => {
  it("is negative at rating ≤ 2 regardless of sentiment", () => {
    expect(isNegativeReview({ rating: 1, sentiment: null })).toBe(true);
    expect(isNegativeReview({ rating: 2, sentiment: "positive" })).toBe(true);
  });

  it("is negative on negative sentiment when unrated or higher-rated", () => {
    expect(isNegativeReview({ rating: null, sentiment: "negative" })).toBe(
      true,
    );
    expect(isNegativeReview({ rating: 4, sentiment: "negative" })).toBe(true);
  });

  it("is not negative otherwise", () => {
    expect(isNegativeReview({ rating: 3, sentiment: null })).toBe(false);
    expect(isNegativeReview({ rating: null, sentiment: "mixed" })).toBe(false);
    expect(isNegativeReview({ rating: 5, sentiment: "positive" })).toBe(false);
    expect(isNegativeReview({ rating: null, sentiment: null })).toBe(false);
  });
});
