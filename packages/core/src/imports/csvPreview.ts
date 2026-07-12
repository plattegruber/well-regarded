/**
 * CSV sniffing + preview parsing for the import upload endpoint
 * (issue #133 reqs. 2 and 8), shared with the mapping wizard (#134), which
 * re-reads the same ranged window to render its preview table and
 * validation preview. Pure functions over bytes — no I/O — so the
 * nasty cases (BOMs, quoted newlines, semicolon delimiters, truncated
 * tails, XLSX masquerading as CSV) are unit-testable without a database.
 *
 * MEMORY BEHAVIOR IN A WORKER (verified; see imports.test.ts "memory
 * behavior"): the preview path decodes AT MOST the 256KB ranged window
 * (`PREVIEW_WINDOW_BYTES`) into a string — never the stored object, which
 * may be 50MB. papaparse is DOM-free and runs fine in workerd; we call it
 * in one-shot mode over that small window with `preview` set, so it stops
 * after ~52 records regardless of input length. The upload itself is held
 * exactly once as a single `Uint8Array` (bytes, not a string — decoding
 * 50MB to UTF-16 would double it), which at the 50MB cap fits comfortably
 * in the 128MB isolate. Full-file parsing happens ROW-STREAMED in the
 * import Workflow (#135), never here.
 */

import Papa from "papaparse";

/** Header + this many data rows in the preview response. */
export const PREVIEW_ROW_COUNT = 50;

/**
 * How much of the stored object the preview reads back (ranged R2 get).
 * 256KB comfortably holds 51 rows of any realistic review export; a file
 * whose single rows outgrow this window previews shorter, never errors.
 */
export const PREVIEW_WINDOW_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Content sniffing (req. 8): reject binary junk EARLY with a human message.
// ---------------------------------------------------------------------------

export type CsvSniffRejection =
  /** ZIP/OLE/PDF/image/gzip magic bytes — almost always an XLSX/XLS. */
  | "binary"
  /** UTF-16 BOM: parseable in principle, but our pipeline is UTF-8-only. */
  | "utf16"
  | "empty";

export type CsvSniffResult =
  | { ok: true }
  | { ok: false; reason: CsvSniffRejection };

const MAGIC_PREFIXES: ReadonlyArray<readonly number[]> = [
  [0x50, 0x4b, 0x03, 0x04], // ZIP local-file header — XLSX, DOCX, …
  [0x50, 0x4b, 0x05, 0x06], // ZIP empty-archive header
  [0xd0, 0xcf, 0x11, 0xe0], // OLE compound file — legacy XLS/DOC
  [0x25, 0x50, 0x44, 0x46], // %PDF
  [0x1f, 0x8b], // gzip
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF8
];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.byteLength < prefix.length) return false;
  return prefix.every((b, i) => bytes[i] === b);
}

/**
 * Sniff the first bytes of an upload. A UTF-8 BOM is tolerated (stripped
 * later by TextDecoder); UTF-16 BOMs and binary magic numbers are
 * rejected. Beyond magic numbers, any NUL byte in the first KB means
 * binary — no text export contains NUL.
 */
export function sniffCsvBytes(bytes: Uint8Array): CsvSniffResult {
  if (bytes.byteLength === 0) return { ok: false, reason: "empty" };
  for (const prefix of MAGIC_PREFIXES) {
    if (startsWith(bytes, prefix)) return { ok: false, reason: "binary" };
  }
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) {
    return { ok: false, reason: "utf16" };
  }
  const window = bytes.subarray(0, 1024);
  for (const byte of window) {
    if (byte === 0) return { ok: false, reason: "binary" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Preview parsing (req. 2)
// ---------------------------------------------------------------------------

export interface CsvPreview {
  /** First row, exactly as parsed — the column names mappings reference. */
  headers: string[];
  /** Up to {@link PREVIEW_ROW_COUNT} data rows, each aligned to `headers`. */
  previewRows: string[][];
  /** What papaparse auto-detected (`;` European exports are real — surface it). */
  delimiter: string;
}

/**
 * Parse header + first 50 data rows from the head of the stored object.
 *
 * `truncated` = the ranged read did not reach the end of the object. Two
 * defenses keep a mid-record cut from leaking a mangled row into the
 * preview: the decoded window is cut back to its last newline (drops a
 * partial final LINE), and — because that newline may sit inside a quoted
 * field — the final parsed RECORD is dropped too. We parse one sacrificial
 * record past the preview budget so the drop never costs a wanted row.
 *
 * Decoding: `TextDecoder("utf-8")` strips a UTF-8 BOM by itself
 * (`ignoreBOM` defaults to false) and replaces invalid sequences with
 * U+FFFD instead of throwing — a Latin-1 "café" degrades to "caf�"
 * in the preview but never breaks CSV structure (mixed encodings
 * handled, not rejected).
 *
 * Returns null when the window contains no parseable row at all.
 */
export function parseCsvPreview(
  bytes: Uint8Array,
  { truncated }: { truncated: boolean },
): CsvPreview | null {
  let text = new TextDecoder("utf-8").decode(bytes);
  if (truncated) {
    const lastNewline = text.lastIndexOf("\n");
    // No newline in 256KB ⇒ one giant partial line ⇒ nothing trustworthy.
    if (lastNewline === -1) return null;
    text = text.slice(0, lastNewline);
  }

  // header + PREVIEW_ROW_COUNT + 1 sacrificial record (see doc above).
  const parseBudget = PREVIEW_ROW_COUNT + 2;
  const result = Papa.parse<string[]>(text, {
    delimiter: "", // auto-detect; meta.delimiter reports the choice
    preview: parseBudget,
    skipEmptyLines: "greedy",
  });

  let rows = result.data;
  if (truncated && rows.length < parseBudget) {
    // The parser ran off the end of the window (did not stop at the
    // budget), so its final record may span the cut — drop it.
    rows = rows.slice(0, -1);
  }

  const [headers, ...dataRows] = rows;
  if (headers === undefined || headers.every((h) => h.trim() === "")) {
    return null;
  }
  return {
    headers,
    previewRows: dataRows.slice(0, PREVIEW_ROW_COUNT),
    delimiter: result.meta.delimiter,
  };
}
