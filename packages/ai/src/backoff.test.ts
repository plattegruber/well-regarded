import { describe, expect, it } from "vitest";

import { backoffDelayMs, isRetryableStatus } from "./backoff.js";

describe("isRetryableStatus", () => {
  it("retries 429, 500, and 529 (overloaded)", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(529)).toBe(true);
  });

  it("never retries 4xx client errors other than 429", () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(422)).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  it("doubles per attempt with equal jitter (random = 0.5 → 75% of the cap)", () => {
    const random = () => 0.5;
    expect(backoffDelayMs(1, { baseDelayMs: 1000, random })).toBe(750);
    expect(backoffDelayMs(2, { baseDelayMs: 1000, random })).toBe(1500);
    expect(backoffDelayMs(3, { baseDelayMs: 1000, random })).toBe(3000);
  });

  it("bounds jitter between half and full delay", () => {
    expect(backoffDelayMs(1, { baseDelayMs: 1000, random: () => 0 })).toBe(500);
    // random() is in [0, 1) so the full delay is an open upper bound.
    expect(
      backoffDelayMs(1, { baseDelayMs: 1000, random: () => 0.999999 }),
    ).toBeLessThan(1000);
  });

  it("caps the exponential at maxDelayMs", () => {
    const random = () => 1 - Number.EPSILON;
    const capped = backoffDelayMs(10, {
      baseDelayMs: 1000,
      maxDelayMs: 4000,
      random,
    });
    expect(capped).toBeLessThanOrEqual(4000);
    expect(capped).toBeGreaterThanOrEqual(2000);
  });

  it("rejects non-positive attempts", () => {
    expect(() => backoffDelayMs(0)).toThrow(RangeError);
    expect(() => backoffDelayMs(-1)).toThrow(RangeError);
    expect(() => backoffDelayMs(1.5)).toThrow(RangeError);
  });
});
