/**
 * Derivation vocabulary — the single source of truth for the `derivations`
 * table's Postgres enums in `@wellregarded/db` (issue #36, Epic #3).
 *
 * `derivations` is where ethical invariant #1 lives: an AI inference is
 * never presented as confirmed fact. Every judgment carries a `basis` from
 * this vocabulary so any consumer can distinguish "a human said this"
 * (`manual`) from "a model guessed this" (`inferred_*`).
 */

/**
 * The judged dimensions. Topics are deliberately NOT a dimension — topics
 * are emergent via embeddings/clusters (Epic #9).
 */
export const DERIVATION_DIMENSIONS = [
  "sentiment",
  "urgency",
  "response_risk",
  "publication_suitability",
] as const;

export type DerivationDimension = (typeof DERIVATION_DIMENSIONS)[number];

/**
 * How the judgment was reached. `manual` outranks every inferred basis when
 * resolving the current derivation — a human correction must never be
 * silently overridden by a newer model run (see
 * `getCurrentDerivations` in `@wellregarded/db`).
 */
export const DERIVATION_BASES = [
  "source_metadata",
  "manual",
  "inferred_text",
  "inferred_related",
] as const;

export type DerivationBasis = (typeof DERIVATION_BASES)[number];
