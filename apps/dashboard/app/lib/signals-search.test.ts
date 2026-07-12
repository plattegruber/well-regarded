// URL-param contract tests for /signals (#88): lenient parsing — unknown
// values read as "no filter", never an error page.
import { describe, expect, it } from "vitest";

import {
  parseSignalsSearch,
  withCursor,
  withoutCursor,
} from "./signals-search";

const parse = (query: string) => parseSignalsSearch(new URLSearchParams(query));

describe("parseSignalsSearch", () => {
  it("returns no filters for an empty query string", () => {
    const search = parse("");
    expect(search.filters).toEqual({});
    expect(search.filtered).toBe(false);
    expect(search.cursor).toBeNull();
  });

  it("parses every filter param", () => {
    const search = parse(
      "source_kind=google&visibility=private&sentiment=negative&urgency=high" +
        "&location=6f9619ff-8b86-4d01-b42d-00cf4fc964ff" +
        "&provider=7f9619ff-8b86-4d01-b42d-00cf4fc964ff" +
        "&suspected_duplicate=1&q=billing&cursor=abc",
    );
    expect(search.filters).toEqual({
      sourceKind: "google",
      visibility: "private",
      sentiment: "negative",
      urgency: "high",
      locationId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
      providerId: "7f9619ff-8b86-4d01-b42d-00cf4fc964ff",
      suspectedDuplicate: true,
      q: "billing",
    });
    expect(search.filtered).toBe(true);
    expect(search.cursor).toBe("abc");
  });

  it("accepts the unclassified sentinel", () => {
    expect(parse("sentiment=unclassified").filters.sentiment).toBe(
      "unclassified",
    );
    expect(parse("urgency=unclassified").filters.urgency).toBe("unclassified");
  });

  it("ignores unknown values instead of erroring", () => {
    const search = parse(
      "source_kind=yelp&visibility=secret&sentiment=angry&urgency=meh" +
        "&location=not-a-uuid&provider=also-not&suspected_duplicate=yes",
    );
    expect(search.filters).toEqual({});
    expect(search.filtered).toBe(false);
  });

  it("trims the search text; whitespace-only is no search", () => {
    expect(parse("q=%20%20").filters.q).toBeUndefined();
    expect(parse("q=%20wait%20time%20").filters.q).toBe("wait time");
  });
});

describe("cursor href helpers", () => {
  it("withCursor sets the cursor and keeps every filter", () => {
    const params = new URLSearchParams("q=billing&visibility=private");
    expect(withCursor(params, "abc123")).toBe(
      "?q=billing&visibility=private&cursor=abc123",
    );
  });

  it("withoutCursor drops only the cursor", () => {
    const params = new URLSearchParams("q=billing&cursor=abc123");
    expect(withoutCursor(params)).toBe("?q=billing");
    expect(withoutCursor(new URLSearchParams("cursor=abc123"))).toBe("");
  });
});
