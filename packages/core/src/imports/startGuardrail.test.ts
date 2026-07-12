import { describe, expect, it } from "vitest";

import type { ColumnMapping } from "./columnMapping.js";
import {
  consentRequiredForMapping,
  importStartIssues,
  mappingConsentChoice,
  mappingVisibilityConstant,
} from "./startGuardrail.js";

const HEADERS = ["Date", "Stars", "Review", "Reviewer", "Patient Email"];

const MAPPING: ColumnMapping = {
  occurredAt: { column: "Date", dateFormat: "MM/DD/YYYY" },
  rating: { column: "Stars", ratingScale: 5 },
  text: { column: "Review" },
  author: { column: "Reviewer" },
  patientEmail: { column: "Patient Email" },
  visibility: { constant: "private" },
  consentHint: { constant: "imported_unknown" },
};

describe("consentRequiredForMapping", () => {
  const base: ColumnMapping = {
    occurredAt: { column: "Date", dateFormat: "ISO" },
    text: { column: "Review" },
  };

  it("public file, no PII → no consent step", () => {
    expect(
      consentRequiredForMapping({
        ...base,
        visibility: { constant: "public" },
      }),
    ).toBe(false);
  });

  it("private constant → required", () => {
    expect(
      consentRequiredForMapping({
        ...base,
        visibility: { constant: "private" },
      }),
    ).toBe(true);
  });

  it("column-mapped visibility → required (rows may be private)", () => {
    expect(
      consentRequiredForMapping({ ...base, visibility: { column: "Review" } }),
    ).toBe(true);
  });

  it("any PII column → required, even for public files", () => {
    expect(
      consentRequiredForMapping({
        ...base,
        visibility: { constant: "public" },
        patientEmail: { column: "Patient Email" },
      }),
    ).toBe(true);
  });
});

describe("importStartIssues (the shared start guardrail)", () => {
  it("empty array for a complete draft", () => {
    expect(
      importStartIssues({
        mapping: MAPPING,
        headers: HEADERS,
        attestationNote: null,
      }),
    ).toEqual([]);
  });

  it("no mapping at all → mapping_missing", () => {
    expect(
      importStartIssues({
        mapping: null,
        headers: HEADERS,
        attestationNote: null,
      }),
    ).toEqual([
      {
        code: "mapping_missing",
        message: "Map the file's columns before starting the import.",
      },
    ]);
  });

  it("schema-invalid mapping → mapping_invalid", () => {
    const issues = importStartIssues({
      mapping: { text: { column: "Review" } },
      headers: HEADERS,
      attestationNote: null,
    });
    expect(issues.map((i) => i.code)).toEqual(["mapping_invalid"]);
  });

  it("mapping referencing missing columns → unknown_columns naming them", () => {
    const issues = importStartIssues({
      mapping: { ...MAPPING, text: { column: "Reviews" } },
      headers: HEADERS,
      attestationNote: null,
    });
    expect(issues.map((i) => i.code)).toEqual(["unknown_columns"]);
    expect(issues[0]?.message).toContain('"Reviews"');
  });

  it("no visibility decision → visibility_missing (stricter than the Workflow's default, by design)", () => {
    const { visibility: _drop, consentHint: _drop2, ...rest } = MAPPING;
    const issues = importStartIssues({
      mapping: rest,
      headers: HEADERS,
      attestationNote: null,
    });
    // PII is mapped, so consent is also still owed.
    expect(issues.map((i) => i.code)).toEqual([
      "visibility_missing",
      "consent_missing",
    ]);
  });

  it("consent required but unanswered → consent_missing", () => {
    const { consentHint: _drop, ...rest } = MAPPING;
    const issues = importStartIssues({
      mapping: rest,
      headers: HEADERS,
      attestationNote: null,
    });
    expect(issues.map((i) => i.code)).toEqual(["consent_missing"]);
  });

  it("practice_attested without a note → attestation_missing; with one → clean", () => {
    const attested = {
      ...MAPPING,
      consentHint: { constant: "practice_attested" },
    };
    expect(
      importStartIssues({
        mapping: attested,
        headers: HEADERS,
        attestationNote: "  ",
      }).map((i) => i.code),
    ).toEqual(["attestation_missing"]);
    expect(
      importStartIssues({
        mapping: attested,
        headers: HEADERS,
        attestationNote: "Signed intake forms, 2021–2024",
      }),
    ).toEqual([]);
  });
});

describe("mapping readers", () => {
  it("mappingConsentChoice / mappingVisibilityConstant read constants only", () => {
    expect(mappingConsentChoice(MAPPING)).toBe("imported_unknown");
    expect(mappingVisibilityConstant(MAPPING)).toBe("private");
    const columnMapped: ColumnMapping = {
      occurredAt: { column: "Date", dateFormat: "ISO" },
      text: { column: "Review" },
      visibility: { column: "Stars" },
      consentHint: { column: "Stars" },
    };
    expect(mappingConsentChoice(columnMapped)).toBeNull();
    expect(mappingVisibilityConstant(columnMapped)).toBeNull();
  });
});
