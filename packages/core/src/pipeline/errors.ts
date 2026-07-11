/**
 * Error vocabulary for pipeline stage handlers (issue #98, Epic #6).
 *
 * Ack/retry semantics are enforced by the dispatcher in `workers/pipeline`,
 * not by individual handlers — a handler communicates its intent by what it
 * throws:
 *
 * - return normally            → the dispatcher `ack()`s the message.
 * - throw `RetryableError`     → the dispatcher `retry()`s (Cloudflare Queues
 *   honors `max_retries: 3`, then dead-letters to the stage's DLQ).
 * - throw `NonRetryableError`  → the message can never succeed (e.g. a
 *   referenced row is gone); the dispatcher forwards it straight to the
 *   stage's DLQ and `ack()`s, so no retry budget is burned on a lost cause.
 * - throw anything else        → treated like `RetryableError`: an unexpected
 *   error might be transient, and the retry → DLQ path guarantees it is
 *   never silently dropped either way.
 */

/**
 * A transient failure (network blip, lock contention, rate limit): the same
 * message is expected to succeed on a later attempt.
 */
export class RetryableError extends Error {
  override name = "RetryableError";
}

/**
 * A permanent failure: retrying the same message can never succeed. The
 * dispatcher sends it to the stage's DLQ immediately instead of retrying.
 */
export class NonRetryableError extends Error {
  override name = "NonRetryableError";
}
