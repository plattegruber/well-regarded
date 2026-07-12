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

/** Narrowing guard for jsonb-stored urgency values (`derivations.value`). */
export function isUrgencyLevel(value: unknown): value is UrgencyLevel {
  return (
    typeof value === "string" &&
    (URGENCY_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * THE urgency ordering (issue #108): `none < low < medium < high <
 * critical`, by position in {@link URGENCY_LEVELS}. Consumers compare
 * through this — never `<` on the strings, which would sort
 * alphabetically ("critical" < "high" < "low" < "medium" < "none").
 */
export function urgencyRank(level: UrgencyLevel): number {
  return URGENCY_LEVELS.indexOf(level);
}

/**
 * Is `level` at or above `threshold` in the urgency ordering? The route
 * stage's recovery branch (issue #108) fires exactly when this is true of
 * a signal's current urgency derivation.
 */
export function meetsUrgencyThreshold(
  level: UrgencyLevel,
  threshold: UrgencyLevel,
): boolean {
  return urgencyRank(level) >= urgencyRank(threshold);
}

/**
 * Default urgency threshold for routing a signal into recovery (issue
 * #108): `high` and `critical` open recovery work; `medium` and below
 * rest in the inbox.
 *
 * Per-practice override is specified by #108 but `practices` has no
 * settings storage yet (no settings jsonb; Epic #3/#4 never shipped one).
 * The route stage takes the threshold as injected config
 * (`RoutingConfig`), so when practice settings land (#122 proposes a
 * settings jsonb on `practices` for recovery windows — the routing
 * threshold belongs in the same mechanism), only the config *loader*
 * changes; every comparison already goes through
 * {@link meetsUrgencyThreshold}.
 */
export const DEFAULT_URGENCY_ROUTING_THRESHOLD: UrgencyLevel = "high";

/**
 * Inbox filter vocabularies (issue #88): the judged values plus
 * `unclassified` — "no current derivation for this dimension", which the
 * inbox filters on honestly rather than hiding.
 */
export const SENTIMENT_FILTERS = [...SENTIMENTS, "unclassified"] as const;

export type SentimentFilter = (typeof SENTIMENT_FILTERS)[number];

export const URGENCY_FILTERS = [...URGENCY_LEVELS, "unclassified"] as const;

export type UrgencyFilter = (typeof URGENCY_FILTERS)[number];

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

/**
 * The canonical value vocabulary per dimension (issue #93) — what the
 * classify pipeline may write and what the manual-reclassification picker
 * offers. One map so the dashboard's correction UI and its action
 * validation can never drift from the pipeline's vocabulary.
 */
export const DERIVATION_DIMENSION_VALUES: Record<
  DerivationDimension,
  readonly string[]
> = {
  sentiment: SENTIMENTS,
  urgency: URGENCY_LEVELS,
  response_risk: RESPONSE_RISKS,
  publication_suitability: PUBLICATION_SUITABILITIES,
};

/** Is `value` in `dimension`'s canonical vocabulary? (issue #93 pickers) */
export function isDerivationValueForDimension(
  dimension: DerivationDimension,
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    DERIVATION_DIMENSION_VALUES[dimension].includes(value)
  );
}
