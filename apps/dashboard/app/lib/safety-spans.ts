// Span plumbing for the composer's inline safety highlights (#79).
//
// Pure functions only — the mark-overlay component
// (safety-highlight-field.tsx) and the composer's stale-finding logic are
// both built on these, so they are testable without a DOM.
//
// STALENESS CONTRACT: findings arrive against a specific draft string. The
// server echoes `checkedHash` (a hash of exactly the text it checked); the
// client compares it against the hash of the CURRENT textarea value and
// discards the whole result on mismatch — spans into text that no longer
// exists must never highlight the wrong words. Re-mapping is deliberately
// not attempted: the debounce will re-check within a second anyway, and a
// wrong highlight is worse than a briefly missing one.

/** The serializable slice of `SafetyFinding` the composer renders. */
export interface ComposerSafetyFinding {
  /** Offsets into the checked draft text; null = whole-draft finding. */
  span: { start: number; end: number } | null;
  code: string;
  reason: string;
  suggestion?: string | undefined;
  level: "info" | "warn" | "block";
}

/** A full safety verdict as the action routes serialize it. */
export interface ComposerSafetyResult {
  level: "ok" | "warn" | "block";
  findings: ComposerSafetyFinding[];
  /** {@link textHash} of the exact text the findings were computed on. */
  checkedHash: string;
}

/**
 * FNV-1a over UTF-16 code units, hex-encoded. Not cryptographic — it only
 * has to answer "is this the same string I sent?" cheaply on every
 * keystroke, identically in workerd and the browser.
 */
export function textHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** True when `result` was computed against exactly `currentText`. */
export function isFreshResult(
  result: ComposerSafetyResult | undefined,
  currentText: string,
): result is ComposerSafetyResult {
  return result !== undefined && result.checkedHash === textHash(currentText);
}

/** One run of characters sharing a highlight level (null = unmarked). */
export interface HighlightSegment {
  text: string;
  level: "warn" | "block" | null;
}

/**
 * Split `value` into contiguous segments for the mark overlay. Rules:
 *
 * - Only spanned warn/block findings mark text; info findings and
 *   whole-draft (span: null) findings render in the list below the field
 *   instead.
 * - Overlapping spans resolve to the more severe level (block > warn).
 * - Spans are clamped to the text bounds and empty/inverted spans are
 *   dropped — a malformed span must never corrupt the overlay.
 * - Adjacent segments with the same level merge, so React keys stay stable
 *   and the overlay stays small.
 */
export function segmentText(
  value: string,
  findings: readonly ComposerSafetyFinding[],
): HighlightSegment[] {
  if (value.length === 0) return [];

  // Severity per character: 0 none, 1 warn, 2 block.
  const severity = new Uint8Array(value.length);
  for (const finding of findings) {
    if (!finding.span || finding.level === "info") continue;
    const start = Math.max(0, Math.min(finding.span.start, value.length));
    const end = Math.max(start, Math.min(finding.span.end, value.length));
    if (end <= start) continue;
    const rank = finding.level === "block" ? 2 : 1;
    for (let i = start; i < end; i++) {
      if (severity[i] === undefined || rank > (severity[i] as number)) {
        severity[i] = rank;
      }
    }
  }

  const segments: HighlightSegment[] = [];
  let runStart = 0;
  for (let i = 1; i <= value.length; i++) {
    if (i === value.length || severity[i] !== severity[runStart]) {
      const rank = severity[runStart];
      segments.push({
        text: value.slice(runStart, i),
        level: rank === 2 ? "block" : rank === 1 ? "warn" : null,
      });
      runStart = i;
    }
  }
  return segments;
}
