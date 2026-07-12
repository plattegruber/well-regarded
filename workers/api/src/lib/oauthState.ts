/**
 * Signed OAuth `state` parameter (issue #118, Epic #7) — the anti-CSRF
 * binding for the Google connect flow.
 *
 * The state carries `{ practiceId, staffId, nonce, exp }` as
 * `base64url(payload).base64url(hmac)`, HMAC-SHA256 keyed by the
 * `GOOGLE_OAUTH_STATE_SECRET` Worker secret. The callback rejects on any
 * signature/shape/expiry problem, and separately on practice/staff mismatch
 * with the authenticated actor — a state minted for one staff session can
 * never complete another's connect flow. The nonce keys the single-use KV
 * record holding the PKCE verifier.
 *
 * WebCrypto only — runs unchanged in Workers, Node >= 20, and Vitest.
 * Verification style follows `patientTokens.ts`: constant-time by
 * construction (`crypto.subtle.verify`), strict base64url decoding, typed
 * failure results instead of throws.
 */

import { z } from "zod";

const payloadSchema = z.object({
  practiceId: z.uuid(),
  staffId: z.uuid(),
  nonce: z.string().min(1),
  /** Unix seconds. */
  exp: z.number().int(),
});

export type OauthStatePayload = z.infer<typeof payloadSchema>;

/** How long a connect attempt may take end-to-end (matches the KV TTL). */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

const SECRET_MIN_BYTES = 32;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Strict decode: canonical unpadded base64url only (see patientTokens.ts). */
function fromBase64Url(text: string): Uint8Array | null {
  if (!BASE64URL_PATTERN.test(text)) return null;
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (toBase64Url(bytes) !== text) return null;
  return bytes;
}

/**
 * Import `GOOGLE_OAUTH_STATE_SECRET` (base64 of >= 32 random bytes) as an
 * HMAC key. A malformed secret is a configuration error — throws.
 */
async function importSecret(
  secret: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  let binary: string;
  try {
    binary = atob(secret);
  } catch {
    throw new Error("GOOGLE_OAUTH_STATE_SECRET is not valid base64.");
  }
  if (binary.length < SECRET_MIN_BYTES) {
    throw new Error(
      `GOOGLE_OAUTH_STATE_SECRET must decode to at least ${SECRET_MIN_BYTES} ` +
        `bytes (got ${binary.length}). Generate with: openssl rand -base64 32`,
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return crypto.subtle.importKey(
    "raw",
    bytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export interface SignOauthStateInput {
  practiceId: string;
  staffId: string;
  nonce: string;
}

/** Mint a signed state. `exp` is now + {@link OAUTH_STATE_TTL_SECONDS}. */
export async function signOauthState(
  input: SignOauthStateInput,
  secret: string,
  now: Date = new Date(),
): Promise<string> {
  const payload: OauthStatePayload = {
    practiceId: input.practiceId,
    staffId: input.staffId,
    nonce: input.nonce,
    exp: Math.floor(now.getTime() / 1000) + OAUTH_STATE_TTL_SECONDS,
  };
  const payloadText = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await importSecret(secret, "sign");
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payloadText) as BufferSource,
  );
  return `${payloadText}.${toBase64Url(new Uint8Array(signature))}`;
}

export type VerifyOauthStateResult =
  | { ok: true; payload: OauthStatePayload }
  | { ok: false; reason: "invalid" | "expired" };

/**
 * Verify a state parameter. Never throws for state problems — returns a
 * typed result. Signature is checked before the payload is even parsed; a
 * tampered state never reaches expiry or binding checks. Callers must ALSO
 * compare `payload.practiceId`/`payload.staffId` to the authenticated actor
 * — that binding check is the CSRF defense, not this function's job.
 */
export async function verifyOauthState(
  state: string,
  secret: string,
  now: Date = new Date(),
): Promise<VerifyOauthStateResult> {
  const parts = state.split(".");
  if (parts.length !== 2) return { ok: false, reason: "invalid" };
  const [payloadText, signatureText] = parts as [string, string];

  const payloadBytes = fromBase64Url(payloadText);
  const signatureBytes = fromBase64Url(signatureText);
  if (!payloadBytes || !signatureBytes) return { ok: false, reason: "invalid" };

  // Constant-time by construction — never decode-and-compare MAC bytes.
  const key = await importSecret(secret, "verify");
  const signatureValid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes as BufferSource,
    encoder.encode(payloadText) as BufferSource,
  );
  if (!signatureValid) return { ok: false, reason: "invalid" };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const parsed = payloadSchema.safeParse(parsedJson);
  if (!parsed.success) return { ok: false, reason: "invalid" };

  if (Math.floor(now.getTime() / 1000) > parsed.data.exp) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload: parsed.data };
}
