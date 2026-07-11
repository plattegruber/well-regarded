/**
 * Fuzzy-path predicate policy (issue #106), as pure functions so it
 * unit-tests without Miniflare or Postgres.
 *
 * The ANN query (`findDuplicateCandidates` in `@wellregarded/db`) applies
 * the cheap SQL predicates — practice scope, ±window on `occurred_at`,
 * not-self, has-embedding — and returns the nearest neighbors with their
 * cosine similarity. THESE functions decide which of those candidates
 * become suspected-duplicate links: similarity strictly above threshold,
 * same rating (nulls never match on this criterion), and a DIFFERENT
 * source identity — same `(source_kind, source_id)` is the exact path's
 * territory, never a fuzzy link.
 */

import type { SourceKind } from "@wellregarded/core";

/** The fields the predicates read off either side of a candidate pair. */
export interface FuzzyComparable {
  /** Canonical `numeric(2,1)` string, e.g. `"4.0"`; null = unrated. */
  rating: string | null;
  sourceKind: SourceKind;
  sourceId: string | null;
}

/**
 * Same source identity = same kind AND the same non-null source id. Two
 * null source ids (e.g. two manual entries) are NOT the same identity —
 * the unique index that feeds the exact path ignores nulls, so fuzzy
 * matching is exactly how null-id duplicates get caught.
 */
export function isSameSourceIdentity(
  a: FuzzyComparable,
  b: FuzzyComparable,
): boolean {
  return (
    a.sourceKind === b.sourceKind &&
    a.sourceId !== null &&
    b.sourceId !== null &&
    a.sourceId === b.sourceId
  );
}

/**
 * Ratings match only when both are present and equal — a null rating never
 * matches anything (an unrated survey response and a 5-star review are not
 * "the same rating", and pretending so would over-link).
 */
export function ratingsMatch(
  a: FuzzyComparable["rating"],
  b: FuzzyComparable["rating"],
): boolean {
  return a !== null && b !== null && a === b;
}

/**
 * The full fuzzy verdict for one candidate: strictly-above-threshold
 * similarity AND matching rating AND a different source identity. The
 * occurred-at window is enforced by the candidate query's WHERE clause.
 */
export function isSuspectedDuplicate(
  candidate: FuzzyComparable & { similarity: number },
  signal: FuzzyComparable,
  threshold: number,
): boolean {
  return (
    candidate.similarity > threshold &&
    ratingsMatch(candidate.rating, signal.rating) &&
    !isSameSourceIdentity(candidate, signal)
  );
}

/** Non-empty text is the fuzzy path's entry ticket (and the embed guard). */
export function hasEmbeddableText(
  text: string | null | undefined,
): text is string {
  return typeof text === "string" && text.trim().length > 0;
}
