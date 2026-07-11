/**
 * Pure retry/backoff math for the AI client (issue #63).
 *
 * Kept free of timers and I/O so it is trivially unit-testable: the
 * provider owns the sleep, this module only decides *whether* to retry and
 * *how long* to wait.
 */

/** Default base delay before the first retry (issue #63: 1s). */
export const DEFAULT_BASE_DELAY_MS = 1_000;
/** Cap on any single backoff delay. */
export const DEFAULT_MAX_DELAY_MS = 30_000;
/** Max total attempts per API request (issue #63: 3). */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Should an HTTP status be retried? 429 (rate limit), every 5xx, and 529
 * (`overloaded_error`) are transient; everything else — 400s in
 * particular — is the caller's bug and must fail immediately.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export interface BackoffOptions {
  /** Delay before the first retry; doubles each subsequent retry. */
  baseDelayMs?: number;
  /** Upper bound on any single delay (pre-jitter). */
  maxDelayMs?: number;
  /** Injectable RNG in [0, 1) so tests are deterministic. */
  random?: () => number;
}

/**
 * Exponential backoff with equal jitter: delay for the retry after
 * `attempt` failures (1-based) is `min(base * 2^(attempt-1), max)`, half
 * fixed and half uniformly random. Equal jitter keeps growth monotonic
 * (unlike full jitter) while still de-synchronizing herds.
 */
export function backoffDelayMs(
  attempt: number,
  {
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    random = Math.random,
  }: BackoffOptions = {},
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  }
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, maxDelayMs);
  return capped / 2 + random() * (capped / 2);
}
