import { describe, expect, it } from "vitest";

import {
  type ColumnMapping,
  columnMappingSchema,
  IMPORT_CONSENT_HINTS,
  IMPORT_DATE_FORMATS,
  isPiiTarget,
  mappedColumns,
  PII_TARGET_FIELDS,
  RATING_SCALES,
  unknownMappingColumns,
} from "./columnMapping.js";

const minimal: ColumnMapping = {
  occurredAt: { column: "Date", dateFormat: "ISO" },
  text: { column: "Review" },
};

describe("columnMappingSchema", () => {
  it("accepts the minimal valid mapping (occurredAt + text)", () => {
    expect(columnMappingSchema.parse(minimal)).toEqual(minimal);
  });

  it("accepts occurredAt + rating with no text (rating is a 'what')", () => {
    const mapping = {
      occurredAt: { column: "Date", dateFormat: "MM/DD/YYYY" },
      rating: { column: "Stars", ratingScale: 5 },
    };
    expect(columnMappingSchema.parse(mapping)).toEqual(mapping);
  });

  it("rejects a mapping with no occurredAt", () => {
    const result = columnMappingSchema.safeParse({
      text: { column: "Review" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path[0])).toContain("occurredAt");
    }
  });

  it("rejects a mapping with neither text nor rating, with the clear message", () => {
    const result = columnMappingSchema.safeParse({
      occurredAt: { column: "Date", dateFormat: "ISO" },
      author: { column: "Name" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(
        /a when \(occurredAt\) and a what \(text or rating\)/,
      );
    }
  });

  it("rejects unknown date formats and rating scales", () => {
    expect(
      columnMappingSchema.safeParse({
        ...minimal,
        occurredAt: { column: "Date", dateFormat: "DD.MM.YYYY" },
      }).success,
    ).toBe(false);
    expect(
      columnMappingSchema.safeParse({
        ...minimal,
        rating: { column: "Stars", ratingScale: 7 },
      }).success,
    ).toBe(false);
  });

  it("accepts every declared date format and rating scale", () => {
    for (const dateFormat of IMPORT_DATE_FORMATS) {
      expect(
        columnMappingSchema.safeParse({
          ...minimal,
          occurredAt: { column: "Date", dateFormat },
        }).success,
      ).toBe(true);
    }
    for (const ratingScale of RATING_SCALES) {
      expect(
        columnMappingSchema.safeParse({
          ...minimal,
          rating: { column: "Stars", ratingScale },
        }).success,
      ).toBe(true);
    }
  });

  it("visibility and consentHint accept a column OR a whole-file constant", () => {
    expect(
      columnMappingSchema.safeParse({
        ...minimal,
        visibility: { column: "Visibility" },
        consentHint: { column: "Consent" },
      }).success,
    ).toBe(true);
    expect(
      columnMappingSchema.safeParse({
        ...minimal,
        visibility: { constant: "private" },
        consentHint: { constant: "imported_unknown" },
      }).success,
    ).toBe(true);
    // But not arbitrary constants.
    expect(
      columnMappingSchema.safeParse({
        ...minimal,
        visibility: { constant: "secret" },
      }).success,
    ).toBe(false);
    expect(
      columnMappingSchema.safeParse({
        ...minimal,
        consentHint: { constant: "patient_link" },
      }).success,
    ).toBe(false);
  });

  it("strict: typo'd fields fail loudly instead of dropping data", () => {
    expect(
      columnMappingSchema.safeParse({
        ...minimal,
        occuredAt: { column: "Date", dateFormat: "ISO" },
      }).success,
    ).toBe(false);
    expect(
      columnMappingSchema.safeParse({
        ...minimal,
        text: { column: "Review", trim: true },
      }).success,
    ).toBe(false);
  });
});

describe("PII flagging", () => {
  it("flags exactly the patient contact targets", () => {
    expect(PII_TARGET_FIELDS).toEqual([
      "patientName",
      "patientEmail",
      "patientPhone",
    ]);
    expect(isPiiTarget("patientEmail")).toBe(true);
    expect(isPiiTarget("author")).toBe(false);
    expect(isPiiTarget("text")).toBe(false);
  });

  it("consent hints stay a subset of core CONSENT_SOURCES minus patient_link", () => {
    expect(IMPORT_CONSENT_HINTS).toEqual([
      "practice_attested",
      "imported_unknown",
    ]);
  });
});

describe("mappedColumns / unknownMappingColumns", () => {
  const mapping: ColumnMapping = {
    occurredAt: { column: "Date", dateFormat: "ISO" },
    text: { column: "Review" },
    patientEmail: { column: "Email" },
    // Constants read no column and must be ignored by the header check.
    visibility: { constant: "private" },
    consentHint: { column: "Consent" },
  };

  it("lists every column-backed target, skipping constants", () => {
    expect(mappedColumns(mapping)).toEqual([
      { field: "occurredAt", column: "Date" },
      { field: "text", column: "Review" },
      { field: "patientEmail", column: "Email" },
      { field: "consentHint", column: "Consent" },
    ]);
  });

  it("reports the mappings whose columns are not in the stored headers", () => {
    expect(
      unknownMappingColumns(mapping, ["Date", "Review", "Email", "Consent"]),
    ).toEqual([]);
    expect(unknownMappingColumns(mapping, ["Date", "Review"])).toEqual([
      { field: "patientEmail", column: "Email" },
      { field: "consentHint", column: "Consent" },
    ]);
  });

  it("matches headers exactly (no trimming or case folding)", () => {
    expect(
      unknownMappingColumns(minimal, ["date", "Review"]).map((u) => u.field),
    ).toEqual(["occurredAt"]);
  });
});
