import { describe, expect, it } from "vitest";

import {
  PREVIEW_ROW_COUNT,
  PREVIEW_WINDOW_BYTES,
  parseCsvPreview,
  sniffCsvBytes,
} from "./csvPreview.js";

const encoder = new TextEncoder();

function csvOf(rowCount: number, prefix = "row"): string {
  const lines = ["Date,Rating,Review"];
  for (let i = 0; i < rowCount; i++) {
    lines.push(`2024-01-02,5,${prefix} ${i}`);
  }
  return `${lines.join("\n")}\n`;
}

describe("sniffCsvBytes (issue #133 req. 8)", () => {
  it("accepts plain CSV text", () => {
    expect(sniffCsvBytes(encoder.encode("a,b\n1,2\n"))).toEqual({ ok: true });
  });

  it("tolerates a UTF-8 BOM", () => {
    expect(
      sniffCsvBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62])),
    ).toEqual({ ok: true });
  });

  it("rejects XLSX (ZIP magic)", () => {
    expect(
      sniffCsvBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])),
    ).toEqual({ ok: false, reason: "binary" });
  });

  it("rejects legacy XLS (OLE magic)", () => {
    expect(
      sniffCsvBytes(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1])),
    ).toEqual({ ok: false, reason: "binary" });
  });

  it("rejects PDFs, gzip, and images", () => {
    for (const bytes of [
      encoder.encode("%PDF-1.7 …"),
      new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      encoder.encode("GIF89a"),
    ]) {
      expect(sniffCsvBytes(bytes)).toEqual({ ok: false, reason: "binary" });
    }
  });

  it("rejects NUL bytes anywhere in the first KB", () => {
    const bytes = encoder.encode("a,b\n1,2\n").slice();
    const withNul = new Uint8Array([...bytes, 0x00, 0x31]);
    expect(sniffCsvBytes(withNul)).toEqual({ ok: false, reason: "binary" });
  });

  it("rejects UTF-16 BOMs with a distinct reason", () => {
    expect(sniffCsvBytes(new Uint8Array([0xff, 0xfe, 0x61, 0x00]))).toEqual({
      ok: false,
      reason: "utf16",
    });
    expect(sniffCsvBytes(new Uint8Array([0xfe, 0xff, 0x00, 0x61]))).toEqual({
      ok: false,
      reason: "utf16",
    });
  });

  it("rejects empty input", () => {
    expect(sniffCsvBytes(new Uint8Array(0))).toEqual({
      ok: false,
      reason: "empty",
    });
  });
});

describe("parseCsvPreview", () => {
  it("parses header + rows and reports the comma delimiter", () => {
    const preview = parseCsvPreview(encoder.encode(csvOf(3)), {
      truncated: false,
    });
    expect(preview).not.toBeNull();
    expect(preview?.headers).toEqual(["Date", "Rating", "Review"]);
    expect(preview?.previewRows).toHaveLength(3);
    expect(preview?.previewRows[0]).toEqual(["2024-01-02", "5", "row 0"]);
    expect(preview?.delimiter).toBe(",");
  });

  it("caps the preview at 50 data rows", () => {
    const preview = parseCsvPreview(encoder.encode(csvOf(200)), {
      truncated: false,
    });
    expect(preview?.previewRows).toHaveLength(PREVIEW_ROW_COUNT);
  });

  it("strips a UTF-8 BOM so the first header is clean", () => {
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...encoder.encode("Date,Review\n2024-01-02,fine\n"),
    ]);
    const preview = parseCsvPreview(bytes, { truncated: false });
    expect(preview?.headers).toEqual(["Date", "Review"]);
  });

  it("preserves quoted newlines inside a field", () => {
    const csv = 'Date,Review\n2024-01-02,"line one\nline two"\n2024-01-03,ok\n';
    const preview = parseCsvPreview(encoder.encode(csv), { truncated: false });
    expect(preview?.previewRows).toEqual([
      ["2024-01-02", "line one\nline two"],
      ["2024-01-03", "ok"],
    ]);
  });

  it("preserves quoted delimiters and escaped quotes", () => {
    const csv = 'A,B\n"1,5","she said ""great"""\n';
    const preview = parseCsvPreview(encoder.encode(csv), { truncated: false });
    expect(preview?.previewRows).toEqual([["1,5", 'she said "great"']]);
  });

  it("auto-detects semicolon delimiters (European exports)", () => {
    const csv = "Datum;Bewertung;Text\n2024-01-02;5;prima\n";
    const preview = parseCsvPreview(encoder.encode(csv), { truncated: false });
    expect(preview?.delimiter).toBe(";");
    expect(preview?.headers).toEqual(["Datum", "Bewertung", "Text"]);
  });

  it("handles CRLF line endings", () => {
    const csv = "Date,Review\r\n2024-01-02,fine\r\n2024-01-03,ok\r\n";
    const preview = parseCsvPreview(encoder.encode(csv), { truncated: false });
    expect(preview?.headers).toEqual(["Date", "Review"]);
    expect(preview?.previewRows).toHaveLength(2);
  });

  it("decodes invalid UTF-8 to replacement chars instead of throwing", () => {
    // 0xE9 is é in Latin-1 — invalid as a lone UTF-8 byte.
    const bytes = new Uint8Array([
      ...encoder.encode("Name,Review\ncaf"),
      0xe9,
      ...encoder.encode(",good\n"),
    ]);
    const preview = parseCsvPreview(bytes, { truncated: false });
    expect(preview?.previewRows[0]?.[0]).toBe("caf�");
  });

  it("a header-only file previews with zero rows", () => {
    const preview = parseCsvPreview(encoder.encode("Date,Review\n"), {
      truncated: false,
    });
    expect(preview?.headers).toEqual(["Date", "Review"]);
    expect(preview?.previewRows).toEqual([]);
  });

  it("returns null for an unparseable window", () => {
    expect(parseCsvPreview(new Uint8Array(0), { truncated: false })).toBeNull();
    expect(
      parseCsvPreview(encoder.encode("   \n \n"), { truncated: false }),
    ).toBeNull();
    // Truncated with no newline at all: one giant partial line.
    expect(
      parseCsvPreview(encoder.encode("x".repeat(1000)), { truncated: true }),
    ).toBeNull();
  });

  describe("truncated windows (mid-object cut)", () => {
    it("drops the partial final line", () => {
      const full = csvOf(10);
      const cut = encoder.encode(full).slice(0, full.indexOf("row 9") + 2);
      const preview = parseCsvPreview(cut, { truncated: true });
      // Row 9's line was cut mid-cell; row 8 is also sacrificed by the
      // drop-last-record guard. Nothing mangled survives.
      expect(preview?.previewRows.length).toBeLessThanOrEqual(9);
      for (const row of preview?.previewRows ?? []) {
        expect(row).toHaveLength(3);
        expect(row[2]).toMatch(/^row \d$/);
      }
    });

    it("survives a cut inside a QUOTED newline without leaking a mangled row", () => {
      const csv =
        'Date,Review\n2024-01-01,ok\n2024-01-02,"first line\nsecond line, still row 2"\n';
      // Cut right after the embedded newline: the window ends with a
      // complete LINE that is half a RECORD.
      const cutAt = csv.indexOf("second line");
      const cut = encoder.encode(csv).slice(0, cutAt);
      const preview = parseCsvPreview(cut, { truncated: true });
      expect(preview?.headers).toEqual(["Date", "Review"]);
      expect(preview?.previewRows).toEqual([["2024-01-01", "ok"]]);
    });

    it("still yields 50 rows when the window holds plenty", () => {
      const big = encoder.encode(csvOf(5000));
      const window = big.slice(0, PREVIEW_WINDOW_BYTES);
      const preview = parseCsvPreview(window, { truncated: true });
      expect(preview?.previewRows).toHaveLength(PREVIEW_ROW_COUNT);
    });
  });

  describe("memory behavior (issue #133 req. 2 — verified, not assumed)", () => {
    it("previews a 10MB file from only its 256KB head window", () => {
      // ~10MB fixture generated in-test; the preview path receives ONLY
      // the ranged head window, exactly as the endpoint reads it back
      // from R2 — the full 10MB string is never handed to papaparse.
      const rows = Math.ceil((10 * 1024 * 1024) / 36);
      const full = encoder.encode(csvOf(rows, "review text payload"));
      expect(full.byteLength).toBeGreaterThan(10 * 1024 * 1024);

      const window = full.slice(0, PREVIEW_WINDOW_BYTES);
      const preview = parseCsvPreview(window, { truncated: true });
      expect(preview?.headers).toEqual(["Date", "Rating", "Review"]);
      expect(preview?.previewRows).toHaveLength(PREVIEW_ROW_COUNT);
      expect(preview?.previewRows[49]?.[2]).toBe("review text payload 49");
    });
  });
});
