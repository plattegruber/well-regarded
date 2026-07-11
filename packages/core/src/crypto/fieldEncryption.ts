/**
 * Field-level encryption for PII contact values (issue #47, Epic #3).
 *
 * Contact values (phone/email) are encrypted at the application layer
 * before they ever reach Postgres, so a leaked dump or an overly-broad
 * query never exposes raw contact data. This module is the ONLY place
 * ciphertext is produced or consumed: nothing outside `packages/db` and
 * `packages/core` touches `value_encrypted` or the keyring, and API
 * responses that include contact info decrypt explicitly at the edge with
 * an `audit()` entry (`patient.viewed`).
 *
 * WebCrypto only (`crypto.subtle`) — this file must run unchanged in
 * Cloudflare Workers, Node >= 20, and Vitest. Never import `node:crypto`
 * here.
 *
 * Ciphertext format: `v<n>:<iv_b64>:<ciphertext_b64>` — AES-256-GCM with a
 * fresh random 12-byte IV per encryption (never reuse an IV under the same
 * key; that one line is where a "simplification" becomes a vulnerability).
 * GCM output already includes the auth tag. The `v<n>` key-version prefix
 * makes rotation cheap: new writes use the highest version in the keyring,
 * old rows still decrypt with the version stamped on them.
 *
 * `hashField` is a deterministic HMAC-SHA256 over the *normalized* value,
 * keyed by `PII_HASH_KEY` (separate from the encryption keys, never rotated
 * casually — rotating it orphans every stored `value_hash`). Determinism
 * deliberately leaks equality: two patients sharing a phone number produce
 * equal hashes. That is exactly the property we want for dedupe and
 * equality lookup without decryption, and an acceptable trade — do NOT
 * "fix" it with a salt-per-row, which would break lookup entirely.
 */

/** Thrown when a ciphertext carries a version the keyring does not have. */
export class UnknownKeyVersionError extends Error {
  constructor(version: number) {
    super(
      `No encryption key for ciphertext version v${version} — ` +
        "the keyring is missing an old key (PII_ENCRYPTION_KEYS must retain " +
        "every version that still has rows in the database).",
    );
    this.name = "UnknownKeyVersionError";
  }
}

/** Thrown when a ciphertext does not match `v<n>:<iv_b64>:<ct_b64>`. */
export class CiphertextFormatError extends Error {
  constructor() {
    super("Ciphertext is not in the expected v<n>:<iv_b64>:<ct_b64> format.");
    this.name = "CiphertextFormatError";
  }
}

/**
 * The parsed key material every encrypt/decrypt/hash call takes. Construct
 * with `createKeyring` (raw material) or `keyringFromEnv` (the two env
 * secrets). Imported `CryptoKey`s are cached inside the object — callers
 * should build one keyring per isolate/request and reuse it; a fresh
 * `importKey` per field is wasteful in the pipeline hot path.
 */
export interface Keyring {
  /** Highest key version — used for all new encryptions. */
  readonly currentVersion: number;
  /** @internal Cached AES-GCM keys by version (lazily imported). */
  encryptionKey(version: number): Promise<CryptoKey>;
  /** @internal Cached HMAC-SHA256 key (lazily imported). */
  hmacKey(): Promise<CryptoKey>;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;

function fromBase64(b64: string, what: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    throw new Error(`${what} is not valid base64.`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function decodeKeyBytes(b64: string, what: string): Uint8Array {
  const bytes = fromBase64(b64, what);
  if (bytes.length !== KEY_BYTES) {
    throw new Error(
      `${what} must decode to exactly ${KEY_BYTES} bytes ` +
        `(got ${bytes.length}). Generate with: openssl rand -base64 32`,
    );
  }
  return bytes;
}

export interface KeyringInput {
  /**
   * Version -> base64 32-byte AES-256 key. Versions are positive integers;
   * the highest is used for new writes. Every version that still has rows
   * in the database must remain present.
   */
  encryptionKeys: Record<string, string>;
  /** Base64 32-byte HMAC key — separate from the encryption keys. */
  hashKey: string;
}

/**
 * Build a `Keyring` from raw key material. Validates eagerly (bad base64 or
 * wrong key length fails here, not on first encrypt) and caches imported
 * `CryptoKey`s for reuse.
 */
export function createKeyring(input: KeyringInput): Keyring {
  const rawByVersion = new Map<number, Uint8Array>();
  for (const [versionText, b64] of Object.entries(input.encryptionKeys)) {
    const version = Number(versionText);
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(
        `PII_ENCRYPTION_KEYS versions must be positive integers (got "${versionText}").`,
      );
    }
    rawByVersion.set(
      version,
      decodeKeyBytes(b64, `PII_ENCRYPTION_KEYS["${versionText}"]`),
    );
  }
  if (rawByVersion.size === 0) {
    throw new Error("PII_ENCRYPTION_KEYS must contain at least one key.");
  }
  const rawHashKey = decodeKeyBytes(input.hashKey, "PII_HASH_KEY");
  const currentVersion = Math.max(...rawByVersion.keys());

  const aesKeys = new Map<number, Promise<CryptoKey>>();
  let hmac: Promise<CryptoKey> | undefined;

  return {
    currentVersion,
    encryptionKey(version: number): Promise<CryptoKey> {
      const cached = aesKeys.get(version);
      if (cached) return cached;
      const raw = rawByVersion.get(version);
      if (!raw) return Promise.reject(new UnknownKeyVersionError(version));
      const imported = crypto.subtle.importKey(
        "raw",
        raw as BufferSource,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"],
      );
      aesKeys.set(version, imported);
      return imported;
    },
    hmacKey(): Promise<CryptoKey> {
      hmac ??= crypto.subtle.importKey(
        "raw",
        rawHashKey as BufferSource,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      return hmac;
    },
  };
}

/**
 * Build a `Keyring` from the two env secrets (see docs/secrets.md):
 *
 * - `PII_ENCRYPTION_KEYS` — JSON `{ "1": "<base64 32 bytes>", "2": ... }`,
 *   highest version used for new writes.
 * - `PII_HASH_KEY` — base64 32 bytes; never rotated casually (rotating it
 *   orphans every stored `value_hash`).
 *
 * The worker env schemas in `env.ts` assert the vars are present as
 * strings; this function owns the structural validation.
 */
export function keyringFromEnv(env: {
  PII_ENCRYPTION_KEYS: string;
  PII_HASH_KEY: string;
}): Keyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.PII_ENCRYPTION_KEYS);
  } catch {
    throw new Error(
      'PII_ENCRYPTION_KEYS must be JSON like { "1": "<base64 32 bytes>" }.',
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "PII_ENCRYPTION_KEYS must be a JSON object mapping versions to base64 keys.",
    );
  }
  for (const value of Object.values(parsed)) {
    if (typeof value !== "string") {
      throw new Error("PII_ENCRYPTION_KEYS values must be base64 strings.");
    }
  }
  return createKeyring({
    encryptionKeys: parsed as Record<string, string>,
    hashKey: env.PII_HASH_KEY,
  });
}

const CIPHERTEXT_PATTERN =
  /^v(\d+):([A-Za-z0-9+/]+={0,2}):([A-Za-z0-9+/]+={0,2})$/;

/**
 * Encrypt a field value with the keyring's current (highest-version) key.
 * Returns `v<n>:<iv_b64>:<ciphertext_b64>`; a fresh random 12-byte IV is
 * generated per call, so encrypting the same plaintext twice yields
 * different ciphertexts that both decrypt identically.
 */
export async function encryptField(
  plaintext: string,
  keyring: Keyring,
): Promise<string> {
  const version = keyring.currentVersion;
  const key = await keyring.encryptionKey(version);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext) as BufferSource,
  );
  return `v${version}:${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`;
}

/**
 * Decrypt a `v<n>:<iv_b64>:<ciphertext_b64>` value using the key version
 * stamped on it. Throws `CiphertextFormatError` on a malformed value,
 * `UnknownKeyVersionError` when the keyring lacks the stamped version, and
 * a WebCrypto `OperationError` when GCM authentication fails (tampered
 * ciphertext or wrong key).
 */
export async function decryptField(
  ciphertext: string,
  keyring: Keyring,
): Promise<string> {
  const match = CIPHERTEXT_PATTERN.exec(ciphertext);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new CiphertextFormatError();
  }
  const key = await keyring.encryptionKey(Number(match[1]));
  const iv = fromBase64(match[2], "ciphertext IV");
  const data = fromBase64(match[3], "ciphertext body");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    data as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Normalize a contact value before hashing — THE single place normalization
 * happens. Equality lookup only works if writers and readers normalize
 * identically, so every `hashField` caller goes through this:
 *
 * - Emails (anything containing `@`): trimmed and lowercased.
 * - Phone numbers: reduced to E.164 digits — formatting characters
 *   stripped, leading `+` dropped, and bare 10-digit numbers get the NANP
 *   country code `1` prepended (we are US-only for now; international
 *   normalization is an adapter concern when a source demands it).
 * - Anything else: trimmed and lowercased (defensive fallback).
 */
export function normalizeContactValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const stripped = trimmed.replace(/[\s().-]/g, "");
  if (/^\+?\d+$/.test(stripped)) {
    const digits = stripped.replace(/^\+/, "");
    return digits.length === 10 ? `1${digits}` : digits;
  }
  return trimmed.toLowerCase();
}

/**
 * Deterministic HMAC-SHA256 (hex) of the normalized value, for the
 * `value_hash` column: equality lookup and dedupe without decryption.
 * Deliberately deterministic — see the module doc comment before "fixing"
 * that.
 */
export async function hashField(
  value: string,
  keyring: Keyring,
): Promise<string> {
  const key = await keyring.hmacKey();
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(normalizeContactValue(value)) as BufferSource,
  );
  return toHex(new Uint8Array(signature));
}
