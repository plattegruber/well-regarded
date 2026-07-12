/**
 * GBP polling constants + pure pacing math (issue #123, Epic #7).
 *
 * THE QUOTA IS SHARED. Google's default 300 QPM is **per GCP project,
 * across every connected practice** (spike #117 / ADR 0002 §3) — so pacing
 * is a correctness requirement, not a nicety, and it has two halves:
 *
 * 1. **Stagger across connections.** The cron tick enumerating connections
 *    and firing every SyncLock DO simultaneously is a synchronized burst by
 *    construction — at ~200+ mapped locations it would 429 itself every
 *    tick even though *average* usage is trivial. Each connection's sync
 *    start is delayed by a deterministic, id-derived jitter spread over
 *    {@link GBP_SYNC_STAGGER_WINDOW_MS}. Deterministic (a hash, not
 *    Math.random) so a connection's slot is stable tick to tick — Google
 *    denies quota increases for "spiky" traffic; a smooth, repeatable shape
 *    is what earns headroom later.
 *
 * 2. **Pace evenly inside a sync.** Per-location fetches are sequential
 *    (never a per-location fan-out), with at least
 *    {@link GBP_MIN_REQUEST_INTERVAL_MS} between Google calls. Budgeting at
 *    80% of quota (240 QPM → 250 ms/call) matches Google's own guidance
 *    ("pace evenly, ~5 req/s at 300 QPM") with headroom for the api
 *    worker's occasional calls (#121 discovery, #127 replies).
 *
 * The ADR Appendix A math this encodes: 100 practices ≈ 200 locations ≈
 * 200 review-list calls per 6h tick ≈ ~50 s paced at 240 QPM — the 6h
 * interval has enormous headroom (theoretical ceiling ~85,000 locations).
 *
 * Everything here is pure (no timers, no I/O) — the sync engine owns the
 * sleeping, this module only decides how long.
 */

/**
 * The cron expression behind the poll (issue #123: every 6 hours). MUST
 * match `triggers.crons` in wrangler.jsonc (all three env blocks) — the
 * scheduled handler dispatches on it, so a drifted edit shows up as a
 * loud "unknown cron" log, not a silent no-op.
 */
export const GBP_POLL_CRON = "0 */6 * * *";

/** Google's default per-project quota after approval (ADR 0002 §3). */
export const GBP_SHARED_QPM_QUOTA = 300;

/** Fraction of quota the poller budgets for itself (headroom for the rest). */
export const GBP_PACING_BUDGET_RATIO = 0.8;

/** The paced call rate: 80% of 300 QPM = 240 QPM. */
export const GBP_PACED_QPM = GBP_SHARED_QPM_QUOTA * GBP_PACING_BUDGET_RATIO;

/** Minimum gap between Google calls inside one sync: 60000/240 = 250 ms. */
export const GBP_MIN_REQUEST_INTERVAL_MS = Math.ceil(60_000 / GBP_PACED_QPM);

/**
 * Window the cron tick spreads connection sync starts over (spike #117:
 * "jittered delay per connection derived from its id, spread over several
 * minutes"). 5 min sits comfortably inside a scheduled handler's 15-minute
 * wall-clock allowance and de-synchronizes hundreds of connections.
 */
export const GBP_SYNC_STAGGER_WINDOW_MS = 5 * 60_000;

/**
 * Runaway guard: pages fetched per location per sync (issue #123
 * implementation note — 20 pages × 50 reviews ≈ 1,000 reviews/location/
 * sync; hitting it is logged loudly and the remainder resumes next tick).
 */
export const GBP_MAX_PAGES_PER_LOCATION = 20;

/**
 * A SyncLock held longer than this is presumed crashed and may be stolen
 * (issue #123 requirement 2's hard cap). Generous on purpose: even a
 * first-ever sync of a big multi-location practice paced at 250 ms/call is
 * minutes, not tens of minutes.
 */
export const SYNC_LOCK_STALE_MS = 30 * 60_000;

/** Max attempts per Google request before the sync aborts (issue #123). */
export const GBP_BACKOFF_MAX_ATTEMPTS = 3;

/** Backoff schedule after attempt N (1-based): 1 s, 4 s, 16 s (pre-jitter). */
export const GBP_BACKOFF_BASE_DELAY_MS = 1_000;

/**
 * Cap on any single backoff delay, jitter AND Retry-After included —
 * deliberate: a sync sleeps inside its DO invocation (and the cron tick
 * awaits it), so one throttled location must never hold a tick hostage
 * for an arbitrary server-sent duration. A `Retry-After` beyond the cap
 * means Google wants a longer pause than a sync will give it: attempts
 * exhaust, the sync aborts gracefully, and the NEXT tick (hours away —
 * far beyond any Retry-After) resumes from the kept cursors.
 */
export const GBP_BACKOFF_MAX_DELAY_MS = 60_000;

/**
 * FNV-1a 32-bit over the connection id — a tiny, dependency-free stable
 * hash. Not cryptographic and doesn't need to be: it only spreads sync
 * starts across the stagger window.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic per-connection stagger delay in `[0, windowMs)`: the same
 * connection always lands in the same slot (smooth, repeatable traffic
 * shape — see module doc), different connections spread uniformly.
 */
export function connectionStaggerMs(
  connectionId: string,
  windowMs: number = GBP_SYNC_STAGGER_WINDOW_MS,
): number {
  if (windowMs <= 0) return 0;
  return fnv1a32(connectionId) % windowMs;
}

/**
 * Delay before retrying a Google request that failed `attempt` times
 * (1-based): exponential 1 s/4 s/16 s with equal jitter (half fixed, half
 * random — keeps growth monotonic while de-synchronizing herds), never
 * less than a server-sent `Retry-After` (issue #123: honor it), capped at
 * {@link GBP_BACKOFF_MAX_DELAY_MS}.
 */
export function gbpBackoffDelayMs(
  attempt: number,
  opts: { retryAfterMs?: number | undefined; random?: () => number } = {},
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  }
  const random = opts.random ?? Math.random;
  const exponential = GBP_BACKOFF_BASE_DELAY_MS * 4 ** (attempt - 1);
  const capped = Math.min(exponential, GBP_BACKOFF_MAX_DELAY_MS);
  const jittered = capped / 2 + random() * (capped / 2);
  return Math.min(
    Math.max(jittered, opts.retryAfterMs ?? 0),
    GBP_BACKOFF_MAX_DELAY_MS,
  );
}
