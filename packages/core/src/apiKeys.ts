/**
 * Publishable API keys for the Proof API (issue #81, Epic #4) — the third
 * and final auth surface after staff JWTs and patient link tokens.
 *
 * Keys are practice-scoped bearer credentials embedded in practice websites
 * (script tags, fetch calls), so they are client-visible BY DESIGN —
 * "publishable" in the Stripe sense. What they must still guarantee:
 *
 * - **Show once.** The plaintext key exists only in the create-response;
 *   the database stores only `hash` (and `last4` as a display hint). It is
 *   never stored, logged, or retrievable afterward.
 * - **Unforgeable.** 32 bytes from `crypto.getRandomValues` — 256 bits of
 *   entropy behind a recognizable `pk_live_` / `pk_test_` prefix.
 *
 * Why plain SHA-256 and not bcrypt/scrypt/HMAC: password hashes exist to
 * slow down offline brute force of LOW-entropy secrets. These keys carry
 * 256 bits of entropy, so brute force is moot, and verification needs a
 * deterministic O(1) UNIQUE-index lookup on `api_keys.key_hash` (the public
 * hot path). A salted or keyed hash would break that lookup for zero
 * security gain. Do not "upgrade" this.
 *
 * Comparison safety: verification never compares plaintext keys — it hashes
 * the presented key and looks the digest up by index equality. Equality of
 * SHA-256 digests leaks nothing useful about the preimage, so the classic
 * timing side channel on secret comparison does not apply.
 *
 * Pure WebCrypto (`crypto.getRandomValues` / `crypto.subtle.digest`): this
 * file must run unchanged in Cloudflare Workers, Node >= 20, and Vitest.
 * Never import `node:crypto` here.
 */

/** The two key environments. `test` keys are flagged on the actor so proof routes can scope to demo/staging data later. */
export const API_KEY_ENVIRONMENTS = ["live", "test"] as const;

export type ApiKeyEnvironment = (typeof API_KEY_ENVIRONMENTS)[number];

/** Bytes of entropy per key; base64url of 32 bytes is 43 chars, unpadded. */
const KEY_RANDOM_BYTES = 32;
const KEY_RANDOM_CHARS = 43;

/**
 * The exact shape of every key this module mints: prefix + 43 base64url
 * chars. `resolveApiKey` in `@wellregarded/db` tests input against this
 * BEFORE hashing — a cheap filter that keeps garbage traffic from costing
 * a digest and a DB lookup.
 */
export const API_KEY_PATTERN = new RegExp(
  `^pk_(live|test)_[A-Za-z0-9_-]{${KEY_RANDOM_CHARS}}$`,
);

/**
 * The authenticated API-key caller, set on Hono context by `apiKeyAuth` —
 * the parallel of `StaffActor` for the proof route group. `keyId` is the
 * identity future rate limiting buckets on (wiring is Epic #22 — the
 * identity is exposed here, the limiter is not built).
 */
export type ApiKeyActor = {
  type: "api_key";
  practiceId: string;
  keyId: string;
  environment: ApiKeyEnvironment;
};

export interface GeneratedApiKey {
  /**
   * The full plaintext key, e.g. `pk_live_…`. **Show once**: return it in
   * the create-response and let go — it must never be stored or logged.
   */
  key: string;
  /** SHA-256 hex of `key` — the only form the database ever sees. */
  hash: string;
  /** Last four characters of `key`, a display hint for the key list UI. */
  last4: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * SHA-256 hex of the full key string — deterministic, unsalted, unkeyed,
 * for the UNIQUE-index lookup on `api_keys.key_hash`. See the module doc
 * comment for why this is correct and must not become a salted hash.
 */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key) as BufferSource,
  );
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Mint a new publishable key: `pk_<environment>_` + base64url of 32
 * crypto-random bytes. Returns the plaintext exactly once, alongside the
 * hash and `last4` the caller persists instead.
 */
export async function generateApiKey(
  environment: ApiKeyEnvironment,
): Promise<GeneratedApiKey> {
  const bytes = new Uint8Array(KEY_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  const key = `pk_${environment}_${toBase64Url(bytes)}`;
  return { key, hash: await hashApiKey(key), last4: key.slice(-4) };
}
