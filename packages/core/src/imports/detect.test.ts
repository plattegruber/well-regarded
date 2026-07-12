import { describe, expect, it } from "vitest";

import {
  classifyHeader,
  detectColumns,
  detectDateFormat,
  detectRatingScale,
  HEADER_HEURISTICS,
} from "./detect.js";

describe("detectDateFormat", () => {
  it("detects ISO dates and datetimes", () => {
    expect(detectDateFormat(["2024-01-02", "2023-12-31"])).toEqual({
      format: "ISO",
    });
    expect(
      detectDateFormat(["2024-01-02T03:04:05Z", "2024-06-01T10:00+02:00"]),
    ).toEqual({ format: "ISO" });
  });

  it("detects the space-separated spreadsheet datetime", () => {
    expect(
      detectDateFormat(["2024-01-02 03:04", "2024-06-01 23:59:59"]),
    ).toEqual({ format: "YYYY-MM-DD HH:mm" });
  });

  it("detects epoch seconds within the plausibility window", () => {
    expect(detectDateFormat(["1704153600", "1735689600"])).toEqual({
      format: "epoch_seconds",
    });
    // Outside 1995–2035 a bare number is not treated as a timestamp.
    expect(detectDateFormat(["4102444800"])).toBeNull();
    expect(detectDateFormat(["123456789"])).toBeNull();
  });

  it("MM/DD vs DD/MM: a day > 12 disambiguates", () => {
    expect(detectDateFormat(["01/13/2024", "02/28/2024"])).toEqual({
      format: "MM/DD/YYYY",
    });
    expect(detectDateFormat(["13/01/2024", "28/02/2024"])).toEqual({
      format: "DD/MM/YYYY",
    });
  });

  it("ambiguous 01/02/2024-style data returns BOTH candidates, never a silent pick", () => {
    expect(detectDateFormat(["01/02/2024", "03/04/2023"])).toEqual({
      ambiguous: ["MM/DD/YYYY", "DD/MM/YYYY"],
    });
  });

  it("one value can disambiguate a whole column", () => {
    expect(detectDateFormat(["01/02/2024", "25/12/2024"])).toEqual({
      format: "DD/MM/YYYY",
    });
  });

  it("rejects impossible calendar dates", () => {
    expect(detectDateFormat(["2024-02-30"])).toBeNull();
    expect(detectDateFormat(["02/30/2024"])).toBeNull();
  });

  it("ignores empty values, but all-empty means no detection", () => {
    expect(detectDateFormat(["", "2024-01-02", " "])).toEqual({
      format: "ISO",
    });
    expect(detectDateFormat(["", "  "])).toBeNull();
    expect(detectDateFormat([])).toBeNull();
  });

  it("mixed garbage means no detection", () => {
    expect(detectDateFormat(["2024-01-02", "yesterday"])).toBeNull();
  });
});

describe("detectRatingScale (issue #133 boundaries)", () => {
  it("[1..5] → 5", () => {
    expect(detectRatingScale(["1", "2", "3", "4", "5"])).toBe(5);
  });

  it("[7] → 10", () => {
    expect(detectRatingScale(["7"])).toBe(10);
  });

  it("[95] → 100", () => {
    expect(detectRatingScale(["95"])).toBe(100);
  });

  it("boundaries are inclusive: 5 → 5, 10 → 10, 100 → 100", () => {
    expect(detectRatingScale(["5", "1"])).toBe(5);
    expect(detectRatingScale(["10", "2"])).toBe(10);
    expect(detectRatingScale(["100"])).toBe(100);
  });

  it("decimals count toward the scale", () => {
    expect(detectRatingScale(["4.5", "3.0"])).toBe(5);
    expect(detectRatingScale(["9.5"])).toBe(10);
  });

  it("not a rating column: >100, negative, or non-numeric → null", () => {
    expect(detectRatingScale(["101"])).toBeNull();
    expect(detectRatingScale(["-1", "4"])).toBeNull();
    expect(detectRatingScale(["4 stars"])).toBeNull();
    expect(detectRatingScale([""])).toBeNull();
    expect(detectRatingScale([])).toBeNull();
  });
});

describe("classifyHeader", () => {
  it.each([
    // [header, expected target]
    ["Review Date", "occurredAt"],
    ["created_at", "occurredAt"],
    ["Timestamp", "occurredAt"],
    ["Visit-Date", "occurredAt"],
    ["Rating", "rating"],
    ["Stars", "rating"],
    ["NPS Score", "rating"],
    ["Review", "text"],
    ["Review Text", "text"],
    ["Comments", "text"],
    ["Feedback", "text"],
    ["Testimonial", "text"],
    ["Reviewer", "author"],
    ["Author Name", "author"],
    ["Display_Name", "author"],
    ["Location", "locationHint"],
    ["Office", "locationHint"],
    ["Branch", "locationHint"],
    ["Provider", "providerHint"],
    ["Doctor", "providerHint"],
    ["Dr. Seen", "providerHint"],
    ["Patient Email", "patientEmail"],
    ["E-Mail", "patientEmail"],
    ["Phone Number", "patientPhone"],
    ["Mobile", "patientPhone"],
    ["Patient", "patientName"],
    ["patient_name", "patientName"],
    ["Visibility", "visibility"],
    ["Public", "visibility"],
    ["Consent", "consentHint"],
    ["Permission to share", "consentHint"],
    ["Order ID", null],
    ["", null],
  ] as const)("%s → %s", (header, expected) => {
    expect(classifyHeader(header)).toBe(expected);
  });

  it("PII wins over generic buckets: patient name is not an author", () => {
    expect(classifyHeader("Patient Name")).toBe("patientName");
    expect(classifyHeader("Patient Phone")).toBe("patientPhone");
  });

  it("occurredAt wins over text: a review DATE is a date", () => {
    expect(classifyHeader("Review Date")).toBe("occurredAt");
  });

  it("word boundaries: 'reviewer' is an author, not review text", () => {
    expect(classifyHeader("Reviewer")).toBe("author");
  });

  it("every heuristic pattern is anchored on word boundaries (source review)", () => {
    for (const { pattern } of HEADER_HEURISTICS) {
      expect(pattern.source).toContain("\\b");
    }
  });
});

describe("detectColumns", () => {
  const headers = ["Date", "Stars", "Review", "Reviewer", "Ref", "Posted"];
  const rows = [
    ["01/02/2024", "5", "Great cleaning", "Pat", "A-1", "2024-01-02"],
    ["03/04/2024", "4", "Kind staff", "Sam", "A-2", "2024-03-04"],
  ];

  it("classifies by header and refines with values", () => {
    const detected = detectColumns(headers, rows);
    expect(detected).toEqual([
      {
        index: 0,
        header: "Date",
        suggestedTarget: "occurredAt",
        dateFormat: { ambiguous: ["MM/DD/YYYY", "DD/MM/YYYY"] },
      },
      { index: 1, header: "Stars", suggestedTarget: "rating", ratingScale: 5 },
      { index: 2, header: "Review", suggestedTarget: "text" },
      { index: 3, header: "Reviewer", suggestedTarget: "author" },
      { index: 4, header: "Ref", suggestedTarget: null },
      {
        index: 5,
        header: "Posted",
        suggestedTarget: "occurredAt",
        dateFormat: { format: "ISO" },
      },
    ]);
  });

  it("suggests occurredAt from values alone when the header says nothing", () => {
    const detected = detectColumns(["Col A"], [["2024-05-01"], ["2024-05-02"]]);
    expect(detected[0]).toEqual({
      index: 0,
      header: "Col A",
      suggestedTarget: "occurredAt",
      dateFormat: { format: "ISO" },
    });
  });

  it("never claims epoch from values alone (ids look like timestamps)", () => {
    const detected = detectColumns(["Ref"], [["1704153600"], ["1735689600"]]);
    expect(detected[0]?.suggestedTarget).toBeNull();
  });

  it("handles ragged rows (missing cells read as empty)", () => {
    const detected = detectColumns(
      ["Date", "Review"],
      [["2024-01-02"], ["2024-01-03", "fine"]],
    );
    expect(detected[0]?.dateFormat).toEqual({ format: "ISO" });
  });
});
