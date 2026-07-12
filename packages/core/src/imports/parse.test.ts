import { describe, expect, it } from "vitest";

import { parseImportDate, parseImportRating } from "./parse.js";

describe("parseImportDate", () => {
  it("parses each supported format to the expected UTC instant", () => {
    expect(parseImportDate("2024-01-02", "ISO")?.toISOString()).toBe(
      "2024-01-02T00:00:00.000Z",
    );
    expect(parseImportDate("2024-01-02T03:04:05Z", "ISO")?.toISOString()).toBe(
      "2024-01-02T03:04:05.000Z",
    );
    // Offset-less datetimes read as UTC — the Workflow's parseCsvDate
    // policy, mirrored here so wizard sample readings agree with it.
    expect(parseImportDate("2024-01-02T03:04", "ISO")?.toISOString()).toBe(
      "2024-01-02T03:04:00.000Z",
    );
    expect(parseImportDate("01/13/2024", "MM/DD/YYYY")?.toISOString()).toBe(
      "2024-01-13T00:00:00.000Z",
    );
    expect(parseImportDate("13/01/2024", "DD/MM/YYYY")?.toISOString()).toBe(
      "2024-01-13T00:00:00.000Z",
    );
    expect(
      parseImportDate("2024-01-02 03:04", "YYYY-MM-DD HH:mm")?.toISOString(),
    ).toBe("2024-01-02T03:04:00.000Z");
    expect(
      parseImportDate("2024-01-02 03:04:59", "YYYY-MM-DD HH:mm")?.toISOString(),
    ).toBe("2024-01-02T03:04:59.000Z");
    expect(parseImportDate("1704153600", "epoch_seconds")?.toISOString()).toBe(
      "2024-01-02T00:00:00.000Z",
    );
  });

  it("nulls anything that does not parse under EXACTLY the chosen format", () => {
    expect(parseImportDate("13/01/2024", "MM/DD/YYYY")).toBeNull();
    expect(parseImportDate("01/13/2024", "DD/MM/YYYY")).toBeNull();
    expect(parseImportDate("2024-02-30", "ISO")).toBeNull();
    expect(parseImportDate("yesterday", "ISO")).toBeNull();
    expect(parseImportDate("", "ISO")).toBeNull();
    // Epoch outside the 1995–2035 plausibility window (detection-side
    // strictness — see the module doc).
    expect(parseImportDate("4102444800", "epoch_seconds")).toBeNull();
  });
});

describe("parseImportRating", () => {
  it("accepts 0..scale, rejects everything else", () => {
    expect(parseImportRating("4.5", 5)).toBe(4.5);
    expect(parseImportRating("0", 10)).toBe(0);
    expect(parseImportRating("10", 10)).toBe(10);
    expect(parseImportRating("6", 5)).toBeNull();
    expect(parseImportRating("-1", 5)).toBeNull();
    expect(parseImportRating("4 stars", 5)).toBeNull();
    expect(parseImportRating("", 5)).toBeNull();
  });
});
