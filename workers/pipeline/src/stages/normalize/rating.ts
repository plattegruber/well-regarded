/**
 * Rating canonicalization policy for the normalize stage (issue #104):
 * `NormalizedRating` (`{ value, scale }`, on the source's own scale) →
 * the `signals.original_rating` column representation.
 *
 * The canonical representation (Epic #3 schema) stores the ORIGINAL value
 * on the source's own scale as `numeric(2,1)` — never lossily rescaled to
 * a common scale. The scale itself is not a column: it is recoverable from
 * the raw artifact in R2, and cross-scale normalization is explicitly
 * adapter/Epic #8 territory, not schema.
 */

import type { NormalizedRating } from "@wellregarded/sources";

/**
 * Format a rating for the `numeric(2,1)` `original_rating` column (drizzle
 * numerics bind as strings), e.g. `{ value: 4, scale: 5 }` → `"4.0"`.
 *
 * Throws on a value the column cannot hold (>= 10): today's sources are all
 * 5-point scales; when a 10-point source lands (Epic #8), widening the
 * column is that adapter's migration to bring — silently truncating here
 * would corrupt original content.
 */
export function canonicalizeRating(
  rating: NormalizedRating | null,
): string | null {
  if (rating === null) return null;
  if (rating.value >= 10) {
    throw new Error(
      `canonicalizeRating: value ${rating.value} does not fit original_rating numeric(2,1) — widen the column before ingesting >9.9 scales`,
    );
  }
  return rating.value.toFixed(1);
}
