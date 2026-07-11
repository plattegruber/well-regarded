/**
 * Dedupe-stage policy constants (issue #106, Epic #6).
 *
 * The fuzzy path finds cross-source duplicate CANDIDATES — same practice,
 * close in time, same rating, near-identical text by embedding cosine
 * similarity — and links them for HUMAN review in the Signals inbox
 * (Epic #11). It never merges: the epic's hard rule is **no silent merges**.
 *
 * These live in `@wellregarded/core` (not the worker) so tuning is a
 * one-line change visible to every consumer: the pipeline stage
 * (`workers/pipeline/src/stages/dedupe.ts`), the candidate query in
 * `packages/db`, and any future eval harness.
 */

/**
 * Cosine similarity above which two signals' text embeddings make the pair
 * a suspected duplicate (given the window/rating/source predicates also
 * hold). 0.92 is a starting point, not gospel — tune it against the eval
 * fixtures in `packages/ai/evals/` once real bge-m3 embeddings (Epic #9,
 * issue #71) are flowing.
 */
export const FUZZY_DUPLICATE_SIMILARITY_THRESHOLD = 0.92;

/**
 * How far apart two signals' `occurred_at` may be (in days, symmetric ±)
 * and still count as fuzzy-duplicate candidates. Google timestamps a review
 * when it was posted; a vendor CSV export may carry the submission date —
 * three days absorbs that skew without matching a patient's genuinely
 * repeated visits weeks apart.
 */
export const FUZZY_DUPLICATE_WINDOW_DAYS = 3;

/**
 * Candidate-pool size for the pgvector ANN query. Kept small: the query
 * orders by cosine distance, so anything past the first few neighbors is
 * already below the similarity threshold at our volumes.
 */
export const FUZZY_DUPLICATE_CANDIDATE_LIMIT = 5;

/**
 * Review states of a `suspected_duplicates` link. The pipeline (#106) only
 * ever writes `pending_review`; the Signals inbox review flow (Epic #11,
 * #90) resolves a link to `confirmed` or `dismissed`. Source of truth for
 * the `suspected_duplicate_status` Postgres enum in `@wellregarded/db`.
 */
export const SUSPECTED_DUPLICATE_STATUSES = [
  "pending_review",
  "confirmed",
  "dismissed",
] as const;

export type SuspectedDuplicateStatus =
  (typeof SUSPECTED_DUPLICATE_STATUSES)[number];
