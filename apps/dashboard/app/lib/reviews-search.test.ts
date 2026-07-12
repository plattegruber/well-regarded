import { describe, expect, it } from "vitest";

import { parseReviewsSearch, withParam } from "./reviews-search";

const parse = (query: string) => parseReviewsSearch(new URLSearchParams(query));

describe("parseReviewsSearch", () => {
  it("parses no params as the unfiltered attention-first view", () => {
    const search = parse("");
    expect(search.filters).toEqual({});
    expect(search.sort).toBe("attention");
    expect(search.cursor).toBeNull();
    expect(search.filtered).toBe(false);
  });

  it("maps the public source vocabulary onto source kinds", () => {
    expect(parse("source=google").filters.source).toBe("google");
    expect(parse("source=csv").filters.source).toBe("csv_import");
    expect(parse("source=manual").filters.source).toBe("manual");
  });

  it("parses status, sentiment, and location", () => {
    const search = parse(
      "status=needs_response&sentiment=negative&location=6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    );
    expect(search.filters.status).toBe("needs_response");
    expect(search.filters.sentiment).toBe("negative");
    expect(search.filters.locationId).toBe(
      "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    );
    expect(search.filtered).toBe(true);
  });

  it("parses multi-select ratings, deduped and bounded", () => {
    expect(parse("rating=1&rating=2&rating=2").filters.ratings).toEqual([1, 2]);
    expect(parse("rating=0&rating=6&rating=abc").filters.ratings).toBe(
      undefined,
    );
  });

  it("ignores bad params instead of erroring (never a 500)", () => {
    const search = parse(
      "source=yelp&status=replied&sentiment=angry&location=not-a-uuid&sort=oldest",
    );
    expect(search.filters).toEqual({});
    expect(search.sort).toBe("attention");
    expect(search.filtered).toBe(false);
  });

  it("parses the explicit newest sort override and the cursor", () => {
    const search = parse("sort=newest&cursor=abc123");
    expect(search.sort).toBe("newest");
    expect(search.cursor).toBe("abc123");
    // Sort and cursor alone do not count as filters.
    expect(search.filtered).toBe(false);
  });

  it("echoes raw values for the controls", () => {
    const search = parse("source=csv&rating=5&status=responded");
    expect(search.values).toEqual({
      source: "csv",
      status: "responded",
      locationId: "",
      ratings: [5],
      sentiment: "",
    });
  });
});

describe("withParam", () => {
  it("sets a param, keeps the rest, and drops the cursor", () => {
    const href = withParam(
      new URLSearchParams("source=google&cursor=xyz"),
      "status",
      "responded",
    );
    expect(href).toContain("source=google");
    expect(href).toContain("status=responded");
    expect(href).not.toContain("cursor");
  });

  it("clears a param with null", () => {
    expect(
      withParam(new URLSearchParams("status=drafted"), "status", null),
    ).toBe("/reviews");
  });
});
