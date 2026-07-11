/**
 * Unit tests for publishable API key generation and hashing (issue #81):
 * format (prefix/length/charset), uniqueness, deterministic hashing, and
 * the `last4` display hint.
 */

import { describe, expect, it } from "vitest";

import { API_KEY_PATTERN, generateApiKey, hashApiKey } from "./apiKeys";

describe("generateApiKey", () => {
  it("live keys carry the pk_live_ prefix", async () => {
    const { key } = await generateApiKey("live");
    expect(key.startsWith("pk_live_")).toBe(true);
  });

  it("test keys carry the pk_test_ prefix", async () => {
    const { key } = await generateApiKey("test");
    expect(key.startsWith("pk_test_")).toBe(true);
  });

  it("random part is 43 base64url chars (32 bytes, unpadded)", async () => {
    const { key } = await generateApiKey("live");
    const random = key.slice("pk_live_".length);
    expect(random).toHaveLength(43);
    expect(random).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generated keys match API_KEY_PATTERN", async () => {
    const live = await generateApiKey("live");
    const test = await generateApiKey("test");
    expect(live.key).toMatch(API_KEY_PATTERN);
    expect(test.key).toMatch(API_KEY_PATTERN);
  });

  it("generations never collide", async () => {
    const keys = await Promise.all(
      Array.from({ length: 50 }, () => generateApiKey("live")),
    );
    expect(new Set(keys.map((k) => k.key)).size).toBe(50);
  });

  it("hash is the SHA-256 hex of the full key", async () => {
    const { key, hash } = await generateApiKey("live");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(await hashApiKey(key));
  });

  it("last4 is the key's final four characters", async () => {
    const { key, last4 } = await generateApiKey("test");
    expect(last4).toBe(key.slice(-4));
    expect(last4).toHaveLength(4);
  });
});

describe("hashApiKey", () => {
  it("is deterministic", async () => {
    const { key } = await generateApiKey("live");
    expect(await hashApiKey(key)).toBe(await hashApiKey(key));
  });

  it("matches the well-known SHA-256 test vector", async () => {
    // SHA-256("abc") — pins the algorithm so a refactor to HMAC/salt fails.
    expect(await hashApiKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("different keys hash differently", async () => {
    const a = await generateApiKey("live");
    const b = await generateApiKey("live");
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("API_KEY_PATTERN", () => {
  it("rejects non-key input before any hashing or DB work", () => {
    for (const bad of [
      "",
      "pk_live_",
      // Wrong prefix ("zk", not Stripe-style "sk" — GitHub push protection
      // rejects anything matching that pattern, even fake fixtures).
      "zk_live_0123456789012345678901234567890123456789012",
      "pk_prod_0123456789012345678901234567890123456789012", // bad env
      "pk_live_too-short",
      `pk_live_${"a".repeat(44)}`, // too long
      `pk_live_${"a".repeat(42)}=`, // padding never appears
      `pk_live_${"a".repeat(42)}+`, // base64 (not url) alphabet
      "Bearer pk_live_x",
    ]) {
      expect(bad).not.toMatch(API_KEY_PATTERN);
    }
  });
});
