/**
 * Signed OAuth state unit tests (issue #118): round-trip, tampering,
 * expiry, wrong secret, malformed input. Pure WebCrypto — no DB, no
 * network.
 */

import { describe, expect, it } from "vitest";

import {
  OAUTH_STATE_TTL_SECONDS,
  type OauthStatePayload,
  signOauthState,
  verifyOauthState,
} from "./oauthState";

// Test-only keys: base64 of >= 32 readable bytes, computed at runtime so
// no secret-shaped literal ever sits in the repo.
const SECRET = btoa("wellregarded-test-only-oauth-state-secret!!");
const OTHER_SECRET = btoa("wellregarded-other-test-oauth-state-secret!");

const INPUT = {
  practiceId: "1f519d33-5b95-4b83-9c8f-1a2b3c4d5e6f",
  staffId: "2a629e44-6ca6-4c94-8d90-2b3c4d5e6f70",
  nonce: "9c8b7a65-4321-4abc-9def-000011112222",
};

function decodePayload(state: string): OauthStatePayload {
  const [payloadText] = state.split(".") as [string];
  const base64 = payloadText.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(atob(base64)) as OauthStatePayload;
}

function encodePayload(payload: OauthStatePayload): string {
  return btoa(JSON.stringify(payload))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

describe("signOauthState / verifyOauthState", () => {
  it("round-trips the practice/staff/nonce binding with a TTL'd exp", async () => {
    const now = new Date("2026-07-11T12:00:00Z");
    const state = await signOauthState(INPUT, SECRET, now);
    const result = await verifyOauthState(state, SECRET, now);
    expect(result).toEqual({
      ok: true,
      payload: {
        ...INPUT,
        exp: Math.floor(now.getTime() / 1000) + OAUTH_STATE_TTL_SECONDS,
      },
    });
  });

  it("rejects a tampered payload (practice swapped) — signature check first", async () => {
    const state = await signOauthState(INPUT, SECRET);
    const [, signature] = state.split(".") as [string, string];
    const forged = encodePayload({
      ...decodePayload(state),
      practiceId: "3b3b3b3b-3b3b-4b3b-8b3b-3b3b3b3b3b3b",
    });
    const result = await verifyOauthState(`${forged}.${signature}`, SECRET);
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a state signed with a different secret", async () => {
    const state = await signOauthState(INPUT, OTHER_SECRET);
    expect(await verifyOauthState(state, SECRET)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects an expired state (10-minute TTL)", async () => {
    const minted = new Date("2026-07-11T12:00:00Z");
    const state = await signOauthState(INPUT, SECRET, minted);
    const later = new Date(
      minted.getTime() + (OAUTH_STATE_TTL_SECONDS + 1) * 1000,
    );
    expect(await verifyOauthState(state, SECRET, later)).toEqual({
      ok: false,
      reason: "expired",
    });
    // One second before the boundary still verifies.
    const justInTime = new Date(
      minted.getTime() + (OAUTH_STATE_TTL_SECONDS - 1) * 1000,
    );
    expect((await verifyOauthState(state, SECRET, justInTime)).ok).toBe(true);
  });

  it("rejects malformed inputs without throwing", async () => {
    for (const garbage of [
      "",
      "just-one-part",
      "a.b.c",
      "!!!.???",
      `${encodePayload({ ...INPUT, exp: 1 })}.` /* empty signature */,
    ]) {
      expect(await verifyOauthState(garbage, SECRET)).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
  });

  it("rejects a validly-signed payload with a non-payload shape", async () => {
    // Sign arbitrary JSON with the real key: shape validation must still
    // reject it (schema check happens after the signature verifies).
    const payloadText = btoa(JSON.stringify({ hello: "world" }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    const keyBytes = Uint8Array.from(atob(SECRET), (ch) => ch.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(payloadText) as BufferSource,
      ),
    );
    let binary = "";
    for (const byte of signature) binary += String.fromCharCode(byte);
    const signatureText = btoa(binary)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect(
      await verifyOauthState(`${payloadText}.${signatureText}`, SECRET),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  it("throws on a malformed secret (configuration error, not a state problem)", async () => {
    await expect(signOauthState(INPUT, "dG9vLXNob3J0")).rejects.toThrow(
      /at least 32 bytes/,
    );
    await expect(signOauthState(INPUT, "not-base64!!!")).rejects.toThrow(
      /not valid base64/,
    );
  });
});
