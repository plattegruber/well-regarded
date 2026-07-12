/**
 * Unit tests for the shared CSV row validation (issue #135): the error
 * matrix with exact plain-language messages, date-format application
 * (including the explicit-choice slash formats), rating-scale conversion,
 * PII → patientHint, visibility/consent parsing, and `sourceId`
 * determinism.
 */

import type { ColumnMapping } from "@wellregarded/core";
import { describe, expect, it } from "vitest";

import {
  csvRowSourceId,
  FIRST_CSV_DATA_ROW_NUMBER,
  parseCsvDate,
  validateCsvRow,
} from "./validateRow.js";

const HEADERS = [
  "Date",
  "Rating",
  "Review",
  "Reviewer",
  "Patient Email",
  "Patient Phone",
  "Doctor",
  "Office",
  "Visibility",
  "Consent",
];

const fullMapping: ColumnMapping = {
  occurredAt: { column: "Date", dateFormat: "MM/DD/YYYY" },
  rating: { column: "Rating", ratingScale: 5 },
  text: { column: "Review" },
  author: { column: "Reviewer" },
  patientName: { column: "Reviewer" },
  patientEmail: { column: "Patient Email" },
  patientPhone: { column: "Patient Phone" },
  providerHint: { column: "Doctor" },
  locationHint: { column: "Office" },
  visibility: { column: "Visibility" },
  consentHint: { column: "Consent" },
};

function row(cells: Partial<Record<(typeof HEADERS)[number], string>>) {
  return HEADERS.map((header) => cells[header] ?? "");
}

describe("parseCsvDate", () => {
  it("applies the explicit MM/DD/YYYY vs DD/MM/YYYY choice — the same value parses differently", () => {
    expect(parseCsvDate("01/02/2024", "MM/DD/YYYY")).toBe(
      "2024-01-02T00:00:00.000Z",
    );
    expect(parseCsvDate("01/02/2024", "DD/MM/YYYY")).toBe(
      "2024-02-01T00:00:00.000Z",
    );
  });

  it("rejects impossible calendar dates instead of rolling them over", () => {
    expect(parseCsvDate("13/45/2023", "MM/DD/YYYY")).toBeNull();
    expect(parseCsvDate("02/30/2024", "MM/DD/YYYY")).toBeNull();
    expect(parseCsvDate("30/02/2024", "DD/MM/YYYY")).toBeNull();
    expect(parseCsvDate("2024-02-30", "ISO")).toBeNull();
  });

  it("parses ISO date-only, datetimes with and without offsets, and rejects other formats", () => {
    expect(parseCsvDate("2026-04-01", "ISO")).toBe("2026-04-01T00:00:00.000Z");
    expect(parseCsvDate("2026-04-01T10:30:00-05:00", "ISO")).toBe(
      "2026-04-01T15:30:00.000Z",
    );
    // Offset-less datetimes are read as UTC — see the module doc.
    expect(parseCsvDate("2026-04-01T10:30", "ISO")).toBe(
      "2026-04-01T10:30:00.000Z",
    );
    expect(parseCsvDate("04/01/2026", "ISO")).toBeNull();
  });

  it("parses the spreadsheet space-separated datetime as UTC", () => {
    expect(parseCsvDate("2026-04-01 10:30", "YYYY-MM-DD HH:mm")).toBe(
      "2026-04-01T10:30:00.000Z",
    );
    expect(parseCsvDate("2026-04-01 10:30:45", "YYYY-MM-DD HH:mm")).toBe(
      "2026-04-01T10:30:45.000Z",
    );
    expect(parseCsvDate("2026-04-01T10:30", "YYYY-MM-DD HH:mm")).toBeNull();
  });

  it("parses bounded epoch seconds", () => {
    expect(parseCsvDate("1743500000", "epoch_seconds")).toBe(
      new Date(1743500000 * 1000).toISOString(),
    );
    expect(parseCsvDate("not-a-number", "epoch_seconds")).toBeNull();
    expect(parseCsvDate("12345678", "epoch_seconds")).toBeNull();
  });
});

describe("validateCsvRow — valid rows", () => {
  it("maps a fully-populated row onto every NormalizedSignal field (golden)", () => {
    const result = validateCsvRow(
      fullMapping,
      HEADERS,
      row({
        Date: "04/01/2026",
        Rating: "4",
        Review: "The hygiene team here is wonderful.",
        Reviewer: "R. Alvarez",
        "Patient Email": "r.alvarez@example.com",
        "Patient Phone": "555-0100",
        Doctor: "Dr. Patel",
        Office: "Main Street office",
        Visibility: "Public",
        Consent: "practice_attested",
      }),
      1,
    );
    expect(result).toEqual({
      ok: true,
      candidate: {
        visibility: "public",
        occurredAt: "2026-04-01T00:00:00.000Z",
        originalText: "The hygiene team here is wonderful.",
        rating: { value: 4, scale: 5 },
        authorDisplayName: "R. Alvarez",
        authorExternalId: null,
        sourceUrl: null,
        consentHint: "practice_attested",
        patientHint: {
          name: "R. Alvarez",
          email: "r.alvarez@example.com",
          phone: "555-0100",
        },
        providerHint: { text: "Dr. Patel", basis: "source_metadata" },
        locationHint: { text: "Main Street office", basis: "source_metadata" },
      },
    });
  });

  it("defaults visibility to private and consent to imported_unknown when unmapped", () => {
    const mapping: ColumnMapping = {
      occurredAt: { column: "Date", dateFormat: "MM/DD/YYYY" },
      text: { column: "Review" },
    };
    const result = validateCsvRow(
      mapping,
      HEADERS,
      row({ Date: "04/01/2026", Review: "Fine visit." }),
      1,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.visibility).toBe("private");
    expect(result.candidate.consentHint).toBe("imported_unknown");
    expect(result.candidate.patientHint).toBeUndefined();
    expect(result.candidate.providerHint).toBeUndefined();
  });

  it("applies bulk constants for visibility and consent (the wizard's file-wide choice)", () => {
    const mapping: ColumnMapping = {
      occurredAt: { column: "Date", dateFormat: "MM/DD/YYYY" },
      text: { column: "Review" },
      visibility: { constant: "public" },
      consentHint: { constant: "practice_attested" },
    };
    const result = validateCsvRow(
      mapping,
      HEADERS,
      row({ Date: "04/01/2026", Review: "Great." }),
      1,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.visibility).toBe("public");
    expect(result.candidate.consentHint).toBe("practice_attested");
  });

  it("keeps ratings on their source scale (10- and 100-point conversions)", () => {
    for (const [scale, value] of [
      [10, "9"],
      [100, "87.5"],
    ] as const) {
      const mapping: ColumnMapping = {
        occurredAt: { column: "Date", dateFormat: "MM/DD/YYYY" },
        rating: { column: "Rating", ratingScale: scale },
      };
      const result = validateCsvRow(
        mapping,
        HEADERS,
        row({ Date: "04/01/2026", Rating: value }),
        1,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.candidate.rating).toEqual({ value: Number(value), scale });
      // Rating-only rows are valid signals: null text, real rating.
      expect(result.candidate.originalText).toBeNull();
    }
  });

  it("treats empty optional cells as absent, never as empty strings", () => {
    const result = validateCsvRow(
      fullMapping,
      HEADERS,
      row({ Date: "04/01/2026", Review: "Just this." }),
      3,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.rating).toBeNull();
    expect(result.candidate.authorDisplayName).toBeNull();
    expect(result.candidate.patientHint).toBeUndefined();
    expect(result.candidate.providerHint).toBeUndefined();
    expect(result.candidate.locationHint).toBeUndefined();
  });
});

describe("validateCsvRow — the error matrix (plain-language messages)", () => {
  it("a date that fails the chosen format errors cleanly, in the #134 copy style", () => {
    const result = validateCsvRow(
      fullMapping,
      HEADERS,
      row({ Date: "13/45/2023", Review: "text" }),
      12,
    );
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          rowNumber: 12,
          column: "Date",
          value: "13/45/2023",
          message:
            "'13/45/2023' isn't a date in the format you chose " +
            "(MM/DD/YYYY). Fix the file or pick a different date format.",
        },
      ],
    });
  });

  it("an empty required date cell errors", () => {
    const result = validateCsvRow(
      fullMapping,
      HEADERS,
      row({ Review: "text" }),
      2,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({
      rowNumber: 2,
      column: "Date",
      value: "",
    });
    expect(result.errors[0]?.message).toContain("cell is empty");
  });

  it("a non-numeric or out-of-scale rating errors", () => {
    const notNumeric = validateCsvRow(
      fullMapping,
      HEADERS,
      row({ Date: "04/01/2026", Rating: "4 stars", Review: "t" }),
      5,
    );
    expect(notNumeric.ok).toBe(false);
    if (!notNumeric.ok) {
      expect(notNumeric.errors[0]?.message).toContain("isn't a number");
    }

    const outOfScale = validateCsvRow(
      fullMapping,
      HEADERS,
      row({ Date: "04/01/2026", Rating: "11", Review: "t" }),
      6,
    );
    expect(outOfScale.ok).toBe(false);
    if (!outOfScale.ok) {
      expect(outOfScale.errors[0]?.message).toContain(
        "outside the 5-point scale",
      );
    }
  });

  it("a malformed patient email errors instead of poisoning the strict wire schema", () => {
    const result = validateCsvRow(
      fullMapping,
      HEADERS,
      row({
        Date: "04/01/2026",
        Review: "t",
        "Patient Email": "not-an-email",
      }),
      7,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({
      column: "Patient Email",
      value: "not-an-email",
    });
    expect(result.errors[0]?.message).toContain(
      "doesn't look like an email address",
    );
  });

  it("unrecognized visibility / consent values error", () => {
    const result = validateCsvRow(
      fullMapping,
      HEADERS,
      row({
        Date: "04/01/2026",
        Review: "t",
        Visibility: "sometimes",
        Consent: "sure",
      }),
      8,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]?.message).toContain("'public' or 'private'");
    expect(result.errors[1]?.message).toContain(
      "'practice_attested' or 'imported_unknown'",
    );
  });

  it("a row with neither text nor rating errors — nothing to import", () => {
    const result = validateCsvRow(
      fullMapping,
      HEADERS,
      row({ Date: "04/01/2026" }),
      9,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain("no review text and no rating");
  });

  it("collects every error on a row, not just the first", () => {
    const result = validateCsvRow(
      fullMapping,
      HEADERS,
      row({ Date: "nope", Rating: "eleven", "Patient Email": "x" }),
      10,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.column)).toEqual([
      "Date",
      "Rating",
      "Patient Email",
    ]);
    expect(result.errors.every((e) => e.rowNumber === 10)).toBe(true);
  });
});

describe("csvRowSourceId", () => {
  it("is deterministic over (draftId, rowNumber) and 1-based rows start at 1", async () => {
    expect(FIRST_CSV_DATA_ROW_NUMBER).toBe(1);
    const draftId = "3b74b0f7-6d7c-4b7e-9f36-1af6a29f2f3a";
    const first = await csvRowSourceId(draftId, 1);
    expect(await csvRowSourceId(draftId, 1)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await csvRowSourceId(draftId, 2)).not.toBe(first);
    expect(
      await csvRowSourceId("aaaaaaaa-0000-0000-0000-000000000000", 1),
    ).not.toBe(first);
  });
});
