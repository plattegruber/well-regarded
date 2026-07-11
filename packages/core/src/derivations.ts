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

/*
 * Per-dimension value vocabularies (issue #67, Epic #9).
 *
 * These are NOT Postgres enums — `derivations.value` is jsonb — but they
 * are the single source of truth for what the classify pipeline writes and
 * what dashboard filters (Epics #10/#11) offer, so writers and readers
 * import the same literals from here.
 */

/**
 * Overall emotional tone toward the practice. `mixed` means genuinely both
 * (real praise AND a real complaint), not mild.
 */
export const SENTIMENTS = ["positive", "mixed", "negative"] as const;

export type Sentiment = (typeof SENTIMENTS)[number];

/**
 * Does this signal need human attention soon? Ordered least → most urgent —
 * `applyUrgencyFloor` in `@wellregarded/ai` depends on this ordering to
 * bump low-confidence judgments up a level.
 */
export const URGENCY_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "critical",
] as const;

export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

/**
 * If the practice replied publicly, how easy is the reply to get wrong?
 * `high` = any reply risks confirming a care relationship or disclosing
 * details; `low` = a generic thank-you is safe.
 */
export const RESPONSE_RISKS = ["low", "medium", "high"] as const;

export type ResponseRisk = (typeof RESPONSE_RISKS)[number];

/** Is the text usable as public proof (with consent)? */
export const PUBLICATION_SUITABILITIES = [
  "suitable",
  "unsuitable",
  "needs_review",
] as const;

export type PublicationSuitability = (typeof PUBLICATION_SUITABILITIES)[number];
