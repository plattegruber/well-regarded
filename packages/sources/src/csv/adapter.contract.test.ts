/**
 * The CSV import adapter proves itself against the shared contract suite
 * (issue #135 requirement 6) with fixtures covering the tricky-CSV matrix:
 * UTF-8 BOM, quoted fields containing newlines, mixed date formats within
 * one file (rows failing the chosen format are skipped cleanly — the
 * Workflow accounts for them), a semicolon delimiter, 10- and 100-scale
 * ratings, and empty optional columns.
 *
 * Fixtures are built by running REAL csv text through `forEachCsvRecord` —
 * the exact parser configuration the import Workflow's chunk step uses —
 * so what the contract suite sees is what `getRawArtifact` would return
 * for a stored batch.
 */

import { describe, expect, it } from "vitest";

import { describeAdapterContract } from "../contract/describeAdapterContract.js";
import { csvImportAdapter } from "./adapter.js";
import { forEachCsvRecord } from "./parse.js";
import {
  buildCsvImportBatchArtifact,
  type CsvImportBatchArtifact,
} from "./schema.js";
import { csvRowSourceId } from "./validateRow.js";

const PRACTICE_ID = "0b54c7c1-32c8-4b02-a24f-8f1a9df6f9f7";
const DRAFT_ID = "3b74b0f7-6d7c-4b7e-9f36-1af6a29f2f3a";

/** Parse a fixture CSV exactly the way the Workflow's chunk step does. */
function envelopeFromCsv(
  csv: string,
  mapping: CsvImportBatchArtifact["mapping"],
): CsvImportBatchArtifact {
  let headers: string[] = [];
  const rows: string[][] = [];
  forEachCsvRecord(csv, {
    onHeader: (h) => {
      headers = h;
    },
    onRow: (row) => {
      rows.push(row);
    },
  });
  return buildCsvImportBatchArtifact({
    practiceId: PRACTICE_ID,
    draftId: DRAFT_ID,
    batchIndex: 0,
    firstRowNumber: 1,
    headers,
    mapping,
    rows,
  });
}

const basicMapping: CsvImportBatchArtifact["mapping"] = {
  occurredAt: { column: "Date", dateFormat: "MM/DD/YYYY" },
  rating: { column: "Rating", ratingScale: 5 },
  text: { column: "Review" },
  author: { column: "Reviewer" },
  patientEmail: { column: "Email" },
  providerHint: { column: "Doctor" },
  consentHint: { constant: "imported_unknown" },
};

/** UTF-8 BOM prefix + Windows line endings — the classic Excel export. */
const bomCsv =
  "\uFEFFDate,Rating,Review,Reviewer,Email,Doctor\r\n" +
  '04/01/2026,5,"Dr. Patel was wonderful with my daughter.",R. Alvarez,r.alvarez@example.com,Dr. Patel\r\n' +
  "04/02/2026,3,,Sam Ortiz,,\r\n";

/** A quoted field containing newlines and an escaped quote. */
const quotedNewlineCsv =
  "Date,Rating,Review,Reviewer,Email,Doctor\n" +
  '04/03/2026,4,"First line.\nSecond line, with a comma.\n""Quoted"" too.",Ana P.,,\n' +
  "04/04/2026,2,Short one.,,,\n";

/**
 * Mixed date formats in one file: the wizard chose MM/DD/YYYY, so the
 * ISO row and the impossible-in-that-format row fail cleanly and are
 * skipped; the two conforming rows normalize.
 */
const mixedDatesCsv =
  "Date,Rating,Review,Reviewer,Email,Doctor\n" +
  "04/05/2026,5,Great cleaning.,,,\n" +
  "2026-04-06,4,ISO date snuck in.,,,\n" +
  "13/45/2023,4,Not a date at all.,,,\n" +
  "04/07/2026,1,Long wait.,,,\n";

/** Semicolon delimiter (European export), 10-point NPS-style scale. */
const semicolonCsv =
  "Date;Score;Feedback\n" +
  "2026-04-08 09:30;9;Would recommend to family\n" +
  "2026-04-09 14:00;6;Parking was rough\n";

const semicolonMapping: CsvImportBatchArtifact["mapping"] = {
  occurredAt: { column: "Date", dateFormat: "YYYY-MM-DD HH:mm" },
  rating: { column: "Score", ratingScale: 10 },
  text: { column: "Feedback" },
};

/** 100-point scale with empty optional columns throughout. */
const hundredScaleCsv =
  "When,Satisfaction,Comments,Patient,Phone\n" +
  "1743500000,87.5,,,\n" +
  "1743600000,42,Front desk was curt.,J. Kim,555-0101\n";

const hundredScaleMapping: CsvImportBatchArtifact["mapping"] = {
  occurredAt: { column: "When", dateFormat: "epoch_seconds" },
  rating: { column: "Satisfaction", ratingScale: 100 },
  text: { column: "Comments" },
  patientName: { column: "Patient" },
  patientPhone: { column: "Phone" },
  visibility: { constant: "private" },
  consentHint: { constant: "practice_attested" },
};

const bomArtifact = envelopeFromCsv(bomCsv, basicMapping);
const quotedNewlineArtifact = envelopeFromCsv(quotedNewlineCsv, basicMapping);
const mixedDatesArtifact = envelopeFromCsv(mixedDatesCsv, basicMapping);
const semicolonArtifact = envelopeFromCsv(semicolonCsv, semicolonMapping);
const hundredScaleArtifact = envelopeFromCsv(
  hundredScaleCsv,
  hundredScaleMapping,
);

describeAdapterContract(csvImportAdapter, {
  valid: [
    {
      name: "UTF-8 BOM + CRLF Excel export",
      artifact: bomArtifact,
      expectedCount: 2,
    },
    {
      name: "quoted fields containing newlines",
      artifact: quotedNewlineArtifact,
      expectedCount: 2,
    },
    {
      name: "mixed date formats — non-conforming rows skipped",
      artifact: mixedDatesArtifact,
      expectedCount: 2,
    },
    {
      name: "semicolon delimiter, 10-point scale",
      artifact: semicolonArtifact,
      expectedCount: 2,
    },
    {
      name: "100-point scale, empty optional columns",
      artifact: hundredScaleArtifact,
      expectedCount: 2,
    },
  ],
  empty: buildCsvImportBatchArtifact({
    practiceId: PRACTICE_ID,
    draftId: DRAFT_ID,
    batchIndex: 0,
    firstRowNumber: 1,
    headers: ["Date", "Review"],
    mapping: {
      occurredAt: { column: "Date", dateFormat: "ISO" },
      text: { column: "Review" },
    },
    rows: [],
  }),
});

describe("csvImportAdapter specifics", () => {
  it("golden normalization: BOM fixture, first row (every field mapped)", async () => {
    // The BOM must not leak into the first header — otherwise the
    // occurredAt column ("Date") would not match and every row would fail.
    expect(bomArtifact.headers[0]).toBe("Date");

    const signals = await csvImportAdapter.normalize(bomArtifact);
    expect(signals[0]).toEqual({
      visibility: "private",
      occurredAt: "2026-04-01T00:00:00.000Z",
      originalText: "Dr. Patel was wonderful with my daughter.",
      rating: { value: 5, scale: 5 },
      authorDisplayName: "R. Alvarez",
      authorExternalId: null,
      sourceKind: "csv_import",
      sourceId: await csvRowSourceId(DRAFT_ID, 1),
      sourceUrl: null,
      consentHint: "imported_unknown",
      patientHint: { email: "r.alvarez@example.com" },
      providerHint: { text: "Dr. Patel", basis: "source_metadata" },
    });
    // Rating-only second row: null text, no hints from empty cells.
    expect(signals[1]).toMatchObject({
      originalText: null,
      rating: { value: 3, scale: 5 },
      authorDisplayName: "Sam Ortiz",
      sourceId: await csvRowSourceId(DRAFT_ID, 2),
    });
    expect(signals[1]?.patientHint).toBeUndefined();
  });

  it("keeps quoted newlines inside one field", async () => {
    const [first] = await csvImportAdapter.normalize(quotedNewlineArtifact);
    expect(first?.originalText).toBe(
      'First line.\nSecond line, with a comma.\n"Quoted" too.',
    );
  });

  it("skips exactly the rows that fail the chosen date format, keeping row-number identity for the rest", async () => {
    const signals = await csvImportAdapter.normalize(mixedDatesArtifact);
    expect(signals.map((s) => s.originalText)).toEqual([
      "Great cleaning.",
      "Long wait.",
    ]);
    // Row 4 keeps sourceId derived from row number 4 — skipped rows do
    // NOT shift identity (that is what makes resumes and re-imports safe).
    expect(signals[1]?.sourceId).toBe(await csvRowSourceId(DRAFT_ID, 4));
  });

  it("carries the 10- and 100-point ratings on their source scales", async () => {
    const [nps] = await csvImportAdapter.normalize(semicolonArtifact);
    expect(nps?.rating).toEqual({ value: 9, scale: 10 });
    expect(nps?.occurredAt).toBe("2026-04-08T09:30:00.000Z");

    const [percent, second] =
      await csvImportAdapter.normalize(hundredScaleArtifact);
    expect(percent?.rating).toEqual({ value: 87.5, scale: 100 });
    expect(percent?.consentHint).toBe("practice_attested");
    expect(second?.patientHint).toEqual({ name: "J. Kim", phone: "555-0101" });
  });

  it("rejects a malformed envelope loudly (our bug, not a row error)", async () => {
    await expect(
      csvImportAdapter.normalize({ kind: "something.else" }),
    ).rejects.toThrow();
    await expect(
      csvImportAdapter.normalize({
        ...bomArtifact,
        mapping: { text: { column: "Review" } }, // no occurredAt: invalid
      }),
    ).rejects.toThrow();
  });
});
