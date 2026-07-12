/**
 * Unit tests for the polling constants and pure pacing math (issue #123):
 * stagger determinism/spread, backoff schedule with jitter bounds and
 * Retry-After honoring, and the stale-lock arithmetic constant.
 */

import { describe, expect, it } from "vitest";

import {
  connectionStaggerMs,
  GBP_BACKOFF_MAX_ATTEMPTS,
  GBP_MIN_REQUEST_INTERVAL_MS,
  GBP_PACED_QPM,
  GBP_SYNC_STAGGER_WINDOW_MS,
  gbpBackoffDelayMs,
  SYNC_LOCK_STALE_MS,
} from "./gbpPolling";

describe("pacing constants", () => {
  it("encodes the spike's quota math: 80% of 300 QPM → 250 ms between calls", () => {
    expect(GBP_PACED_QPM).toBe(240);
    expect(GBP_MIN_REQUEST_INTERVAL_MS).toBe(250);
  });

  it("keeps the issue's numbers for lock staleness and attempts", () => {
    expect(SYNC_LOCK_STALE_MS).toBe(30 * 60_000);
    expect(GBP_BACKOFF_MAX_ATTEMPTS).toBe(3);
  });
});

describe("connectionStaggerMs", () => {
  it("is deterministic per connection id", () => {
    const id = "0c8e4bde-6a1f-4f3e-9f43-0a4be1e0e001";
    expect(connectionStaggerMs(id)).toBe(connectionStaggerMs(id));
  });

  it("always lands inside the window", () => {
    for (let i = 0; i < 200; i++) {
      const delay = connectionStaggerMs(`connection-${i}`);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(GBP_SYNC_STAGGER_WINDOW_MS);
    }
  });

  it("spreads distinct connections across the window (not one burst)", () => {
    const delays = new Set<number>();
    for (let i = 0; i < 50; i++) {
      delays.add(connectionStaggerMs(`connection-${i}`));
    }
    // 50 ids over a 300k ms window: collisions are astronomically unlikely;
    // a broken hash (everything at 0) fails loudly here.
    expect(delays.size).toBeGreaterThan(40);
  });

  it("degenerates to zero for a non-positive window", () => {
    expect(connectionStaggerMs("anything", 0)).toBe(0);
  });
});

describe("gbpBackoffDelayMs", () => {
  it("follows the 1s/4s/16s schedule (upper bound, random=1)", () => {
    const random = () => 1;
    expect(gbpBackoffDelayMs(1, { random })).toBe(1_000);
    expect(gbpBackoffDelayMs(2, { random })).toBe(4_000);
    expect(gbpBackoffDelayMs(3, { random })).toBe(16_000);
  });

  it("equal jitter keeps at least half of each step (random=0)", () => {
    const random = () => 0;
    expect(gbpBackoffDelayMs(1, { random })).toBe(500);
    expect(gbpBackoffDelayMs(2, { random })).toBe(2_000);
    expect(gbpBackoffDelayMs(3, { random })).toBe(8_000);
  });

  it("honors a Retry-After larger than the schedule", () => {
    expect(
      gbpBackoffDelayMs(1, { random: () => 1, retryAfterMs: 30_000 }),
    ).toBe(30_000);
  });

  it("ignores a Retry-After smaller than the schedule", () => {
    expect(gbpBackoffDelayMs(3, { random: () => 1, retryAfterMs: 1_000 })).toBe(
      16_000,
    );
  });

  it("caps even a huge Retry-After", () => {
    expect(
      gbpBackoffDelayMs(1, { random: () => 1, retryAfterMs: 600_000 }),
    ).toBe(60_000);
  });

  it("rejects nonsense attempts", () => {
    expect(() => gbpBackoffDelayMs(0)).toThrow(RangeError);
    expect(() => gbpBackoffDelayMs(1.5)).toThrow(RangeError);
  });
});
