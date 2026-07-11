import { describe, expect, it } from "vitest";

import {
  CiphertextFormatError,
  createKeyring,
  decryptField,
  encryptField,
  hashField,
  keyringFromEnv,
  normalizeContactValue,
  UnknownKeyVersionError,
} from "./fieldEncryption";

// Test-only key material (openssl rand -base64 32) — never real secrets.
const KEY_V1 = "3l4Zg1nkiYyIDvi2rL9BW6BpAgLE0za88AGB98s8xIo=";
const KEY_V2 = "vJmzn7DrKKzobtsgm2XQrpZFAAYCzWTMSNqQ0IJyEsc=";
const HASH_KEY = "H0M2t0Cyp0kWt3pWn4E2G9dY0aQx8bH4bBqkYb7t0eE=";

function v1Keyring() {
  return createKeyring({ encryptionKeys: { "1": KEY_V1 }, hashKey: HASH_KEY });
}

function v1v2Keyring() {
  return createKeyring({
    encryptionKeys: { "1": KEY_V1, "2": KEY_V2 },
    hashKey: HASH_KEY,
  });
}

describe("encryptField / decryptField", () => {
  it("round-trips a plaintext", async () => {
    const keyring = v1Keyring();
    const ciphertext = await encryptField("patient@example.com", keyring);
    expect(ciphertext).toMatch(
      /^v1:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/,
    );
    await expect(decryptField(ciphertext, keyring)).resolves.toBe(
      "patient@example.com",
    );
  });

  it("produces different ciphertexts for the same plaintext (fresh IV) that decrypt identically", async () => {
    const keyring = v1Keyring();
    const a = await encryptField("+15551234567", keyring);
    const b = await encryptField("+15551234567", keyring);
    expect(a).not.toBe(b);
    await expect(decryptField(a, keyring)).resolves.toBe("+15551234567");
    await expect(decryptField(b, keyring)).resolves.toBe("+15551234567");
  });

  it("rejects tampered ciphertext (GCM authentication)", async () => {
    const keyring = v1Keyring();
    const ciphertext = await encryptField("secret value", keyring);
    const parts = ciphertext.split(":");
    const body = parts[2] as string;
    // Flip a character in the ciphertext body (avoid the base64 padding).
    const tampered = `${parts[0]}:${parts[1]}:${
      (body[0] === "A" ? "B" : "A") + body.slice(1)
    }`;
    await expect(decryptField(tampered, keyring)).rejects.toThrow();
  });

  it("rotates: new writes carry v2, old v1 rows still decrypt", async () => {
    const v1Only = v1Keyring();
    const oldCiphertext = await encryptField("old row", v1Only);
    expect(oldCiphertext.startsWith("v1:")).toBe(true);

    const rotated = v1v2Keyring();
    const newCiphertext = await encryptField("new row", rotated);
    expect(newCiphertext.startsWith("v2:")).toBe(true);
    await expect(decryptField(oldCiphertext, rotated)).resolves.toBe("old row");
    await expect(decryptField(newCiphertext, rotated)).resolves.toBe("new row");
  });

  it("throws a typed error for an unknown key version", async () => {
    const keyring = v1Keyring();
    const ciphertext = await encryptField("value", keyring);
    const orphaned = ciphertext.replace(/^v1:/, "v9:");
    await expect(decryptField(orphaned, keyring)).rejects.toBeInstanceOf(
      UnknownKeyVersionError,
    );
  });

  it("throws a typed error for a malformed ciphertext", async () => {
    await expect(
      decryptField("not-a-ciphertext", v1Keyring()),
    ).rejects.toBeInstanceOf(CiphertextFormatError);
  });
});

describe("hashField normalization", () => {
  it("is deterministic for the same normalized value", async () => {
    const keyring = v1Keyring();
    const a = await hashField("patient@example.com", keyring);
    const b = await hashField("patient@example.com", keyring);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("normalizes emails: case and surrounding whitespace are irrelevant", async () => {
    const keyring = v1Keyring();
    expect(await hashField(" Foo@Bar.COM ", keyring)).toBe(
      await hashField("foo@bar.com", keyring),
    );
  });

  it("normalizes phone numbers to E.164 digits", async () => {
    const keyring = v1Keyring();
    expect(await hashField("(555) 123-4567", keyring)).toBe(
      await hashField("+15551234567", keyring),
    );
  });

  it("distinguishes genuinely different values", async () => {
    const keyring = v1Keyring();
    expect(await hashField("a@example.com", keyring)).not.toBe(
      await hashField("b@example.com", keyring),
    );
  });

  it("exposes normalizeContactValue as the single normalization point", () => {
    expect(normalizeContactValue(" Foo@Bar.COM ")).toBe("foo@bar.com");
    expect(normalizeContactValue("(555) 123-4567")).toBe("15551234567");
    expect(normalizeContactValue("+1 555.123.4567")).toBe("15551234567");
  });
});

describe("keyring construction", () => {
  it("parses the two env secrets", async () => {
    const keyring = keyringFromEnv({
      PII_ENCRYPTION_KEYS: JSON.stringify({ "1": KEY_V1, "2": KEY_V2 }),
      PII_HASH_KEY: HASH_KEY,
    });
    expect(keyring.currentVersion).toBe(2);
    const ciphertext = await encryptField("x", keyring);
    expect(ciphertext.startsWith("v2:")).toBe(true);
  });

  it("rejects malformed PII_ENCRYPTION_KEYS JSON", () => {
    expect(() =>
      keyringFromEnv({
        PII_ENCRYPTION_KEYS: "not json",
        PII_HASH_KEY: HASH_KEY,
      }),
    ).toThrow(/must be JSON/);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() =>
      createKeyring({ encryptionKeys: { "1": "c2hvcnQ=" }, hashKey: HASH_KEY }),
    ).toThrow(/32 bytes/);
  });

  it("rejects non-integer key versions", () => {
    expect(() =>
      createKeyring({ encryptionKeys: { latest: KEY_V1 }, hashKey: HASH_KEY }),
    ).toThrow(/positive integers/);
  });

  it("rejects an empty keyring", () => {
    expect(() =>
      createKeyring({ encryptionKeys: {}, hashKey: HASH_KEY }),
    ).toThrow(/at least one key/);
  });
});
