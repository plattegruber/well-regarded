// parseMappingForm (#134): the dynamic step-1 form → ColumnMapping, in the
// node environment (this is server-side parsing).
import { describe, expect, it } from "vitest";

import { parseMappingForm } from "./import-mapping-form";

const HEADERS = ["Date", "Stars", "Review", "Reviewer", "Patient Email"];

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.append(key, value);
  return fd;
}

const COMPLETE = {
  "column-0": "occurredAt",
  "dateFormat-0": "MM/DD/YYYY",
  "column-1": "rating",
  "ratingScale-1": "5",
  "column-2": "text",
  "column-3": "author",
  "column-4": "patientEmail",
  visibility: "private",
};

describe("parseMappingForm", () => {
  it("assembles a full mapping, columns referenced by header text", () => {
    const result = parseMappingForm(form(COMPLETE), HEADERS);
    expect(result).toEqual({
      ok: true,
      mapping: {
        occurredAt: { column: "Date", dateFormat: "MM/DD/YYYY" },
        rating: { column: "Stars", ratingScale: 5 },
        text: { column: "Review" },
        author: { column: "Reviewer" },
        patientEmail: { column: "Patient Email" },
        visibility: { constant: "private" },
      },
    });
  });

  it("unmapped columns are simply left out (don't import is the default)", () => {
    const result = parseMappingForm(
      form({
        "column-0": "occurredAt",
        "dateFormat-0": "ISO",
        "column-2": "text",
        visibility: "public",
      }),
      HEADERS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(Object.keys(result.mapping).sort()).toEqual([
      "occurredAt",
      "text",
      "visibility",
    ]);
  });

  it("a date column without an explicit format is a field error — the ambiguous case can never slide through", () => {
    const { "dateFormat-0": _drop, ...rest } = COMPLETE;
    const result = parseMappingForm(form(rest), HEADERS);
    expect(result).toEqual({
      ok: false,
      fieldErrors: {
        "dateFormat-0": [
          "Choose how these dates should be read before continuing.",
        ],
      },
    });
  });

  it("a rating column needs its scale", () => {
    const { "ratingScale-1": _drop, ...rest } = COMPLETE;
    const result = parseMappingForm(form(rest), HEADERS);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.fieldErrors["ratingScale-1"]).toEqual([
      "Choose the scale these ratings are on.",
    ]);
  });

  it("two columns on one target: the second gets the error, naming the first", () => {
    const result = parseMappingForm(
      form({ ...COMPLETE, "column-3": "text" }),
      HEADERS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.fieldErrors["column-3"]).toEqual([
      '"Review" is already mapped to review text. Un-map one of the two columns.',
    ]);
  });

  it("no date column mapped → plain-language form error", () => {
    const result = parseMappingForm(
      form({ "column-2": "text", visibility: "public" }),
      HEADERS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.fieldErrors[""]?.[0]).toContain("every entry needs a when");
  });

  it("neither text nor rating mapped → plain-language form error", () => {
    const result = parseMappingForm(
      form({
        "column-0": "occurredAt",
        "dateFormat-0": "ISO",
        visibility: "public",
      }),
      HEADERS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.fieldErrors[""]?.[0]).toContain("nothing to import");
  });

  it("file-level visibility is required unless a column carries it", () => {
    const { visibility: _drop, ...rest } = COMPLETE;
    const missing = parseMappingForm(form(rest), HEADERS);
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("unreachable");
    expect(missing.fieldErrors.visibility?.[0]).toContain(
      "public reviews or private feedback",
    );

    const columnMapped = parseMappingForm(
      form({ ...rest, "column-4": "visibility" }),
      HEADERS,
    );
    expect(columnMapped.ok).toBe(true);
    if (!columnMapped.ok) throw new Error("unreachable");
    expect(columnMapped.mapping.visibility).toEqual({
      column: "Patient Email",
    });
  });
});
