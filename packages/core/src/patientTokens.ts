/**
 * Patient link tokens — signed, single-purpose, expiring (issue #70, Epic #4).
 *
 * Patients never get accounts. Every patient-facing interaction — leaving
 * feedback, a review invite, granting consent, opting out — happens through a
 * link containing one of these tokens, and this token design is the ONLY
 * authentication `apps/patient` will ever have. Its properties are
 * load-bearing: purpose-bound (a feedback token cannot grant consent),
 * time-bound (TTL fixed per purpose in `TOKEN_TTLS` — callers cannot pass
 * arbitrary TTLs), single-use for state-changing purposes, and
 * revocable-by-expiry. There is deliberately no refresh, renewal, or
 * multi-purpose token: a patient who lets a link expire gets a new link.
 *
 * Format: compact JWS, HS256, hand-rolled on WebCrypto (`crypto.subtle`) —
 * this file must run unchanged in Cloudflare Workers, Node >= 20, and Vitest.
 * Never import `node:crypto` here. The hand-rolled scope is small:
 * `base64url(header).base64url(payload)` signed with HMAC-SHA256. The header
 * is fixed to `{ alg: 'HS256', typ: 'JWT' }` and verification rejects any
 * other header — that kills `alg: none` and algorithm-downgrade games.
 * Signature comparison is `crypto.subtle.verify`, which is constant-time by
 * construction — never decode-and-compare MAC bytes with `===`. The base64url
 * decoder rejects padding/alphabet tricks by re-encoding and comparing.
 *
 * Single-use enforcement — decision: Cloudflare KV, via the injected
 * `UsedTokenStore` so this package stays pure. `apps/patient` (Epic #21)
 * implements the store over a KV namespace (`used_token:<jti>` with
 * `expirationTtl` = seconds until `exp`, so KV garbage-collects the entry
 * exactly when the token dies anyway). Why KV over a `used_tokens` Postgres
 * table: TTL-native cleanup with zero table growth, and no DB round-trip in
 * the patient hot path. The trade-off is KV's ~60s eventual-consistency
 * window: a token consumed at one edge location may briefly verify at
 * another, so the worst case is a duplicate submission — harmless for all
 * four purposes (feedback dedupes, consent grant is idempotent via
 * `consent_version`, opt-out is idempotent). If a future purpose needs strict
 * global single-use, swap in a `used_tokens` Postgres table (unique insert on
 * `jti`) behind the same interface.
 *
 * Semantics: single-use means **consumed on successful submission, not on
 * page view** — patients open links repeatedly before acting.
 * `verifyPatientToken` only *checks* `isUsed`; callers invoke `markUsed`
 * after the action commits, and only then.
 *
 * `jti` is also the audit identity: Epic #3's `audit_log` records
 * patient-token actors as `{ type: 'patient_token', jti }`, which links an
 * audit trail to a token without embedding PII in either.
 */

import { z } from "zod";

/** The four link purposes. A token is bound to exactly one. */
export type TokenPurpose = "feedback" | "review_invite" | "consent" | "optout";

/**
 * Time-to-live per purpose, in seconds. `createPatientToken` computes `exp`
 * from this map — callers cannot pass arbitrary TTLs.
 */
export const TOKEN_TTLS: Record<TokenPurpose, number> = {
  feedback: 14 * 24 * 60 * 60,
  review_invite: 14 * 24 * 60 * 60,
  consent: 30 * 24 * 60 * 60,
  optout: 90 * 24 * 60 * 60,
};

const claimsSchema = z.object({
  purpose: z.enum(["feedback", "review_invite", "consent", "optout"]),
  patient_id: z.string().min(1),
  practice_id: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(1),
});

/** The signed claims. `iat`/`exp` are unix seconds; `jti` is a random UUID. */
export type PatientTokenClaims = z.infer<typeof claimsSchema>;

/**
 * Single-use ledger contract. `packages/core` stays pure; `apps/patient`
 * implements this over a KV namespace (see the module doc comment for the
 * KV-vs-Postgres decision). `markUsed` is called by the route handler after
 * the patient's action commits — never by `verifyPatientToken`.
 */
export interface UsedTokenStore {
  isUsed(jti: string): Promise<boolean>;
  markUsed(jti: string, ttlSeconds: number): Promise<void>;
}

/**
 * In-memory `UsedTokenStore` for tests and local dev. Honors `ttlSeconds`
 * against the real clock (entries lapse when the token would have expired
 * anyway, mirroring KV's `expirationTtl`).
 */
export class MemoryUsedTokenStore implements UsedTokenStore {
  private readonly expiresAtMs = new Map<string, number>();

  async isUsed(jti: string): Promise<boolean> {
    const expiresAt = this.expiresAtMs.get(jti);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.expiresAtMs.delete(jti);
      return false;
    }
    return true;
  }

  async markUsed(jti: string, ttlSeconds: number): Promise<void> {
    this.expiresAtMs.set(jti, Date.now() + ttlSeconds * 1000);
  }
}

/** Why a token failed verification. Never thrown — returned. */
export type VerifyFailureReason =
  | "invalid"
  | "expired"
  | "used"
  | "wrong_purpose";

export type VerifyResult =
  | { ok: true; claims: PatientTokenClaims }
  | { ok: false; reason: VerifyFailureReason };

/**
 * Seconds of clock skew tolerated when checking `exp` — a token is only
 * `expired` once `now` is more than this far past `exp`.
 */
const EXP_LEEWAY_SECONDS = 60;

const SECRET_MIN_BYTES = 32;

/** The only header this module ever produces or accepts. */
const FIXED_HEADER = { alg: "HS256", typ: "JWT" } as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * Strict base64url decode: unpadded, canonical, `-_` alphabet only. Rejects
 * padding/alphabet tricks by round-tripping — the decoded bytes must
 * re-encode to exactly the input, so no two distinct strings decode to the
 * same bytes (non-canonical trailing bits, stray `=`, or `+/` all fail).
 * Returns `null` on any deviation; the caller maps that to `invalid`.
 */
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
 * Import `PATIENT_TOKEN_SECRET` as an HMAC-SHA256 key. The secret is base64
 * of >= 32 random bytes (generate with `openssl rand -base64 32`; see
 * docs/secrets.md). A malformed secret is a configuration error, not a token
 * problem, so this throws.
 */
async function importSecret(
  secret: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  let binary: string;
  try {
    binary = atob(secret);
  } catch {
    throw new Error("PATIENT_TOKEN_SECRET is not valid base64.");
  }
  if (binary.length < SECRET_MIN_BYTES) {
    throw new Error(
      `PATIENT_TOKEN_SECRET must decode to at least ${SECRET_MIN_BYTES} bytes ` +
        `(got ${binary.length}). Generate with: openssl rand -base64 32`,
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

export interface CreatePatientTokenInput {
  purpose: TokenPurpose;
  patientId: string;
  practiceId: string;
}

/**
 * Mint a compact JWS for one patient, one practice, one purpose. `exp` is
 * `now` plus `TOKEN_TTLS[purpose]` — the TTL is not a parameter by design.
 * `now` is injectable for tests only.
 */
export async function createPatientToken(
  input: CreatePatientTokenInput,
  secret: string,
  now: Date = new Date(),
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  const claims: PatientTokenClaims = {
    purpose: input.purpose,
    patient_id: input.patientId,
    practice_id: input.practiceId,
    iat,
    exp: iat + TOKEN_TTLS[input.purpose],
    jti: crypto.randomUUID(),
  };
  const signingInput = `${toBase64Url(encoder.encode(JSON.stringify(FIXED_HEADER)))}.${toBase64Url(
    encoder.encode(JSON.stringify(claims)),
  )}`;
  const key = await importSecret(secret, "sign");
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signingInput) as BufferSource,
  );
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * Verify a patient link token. Never throws for token problems — returns a
 * typed result. The check order is fixed and load-bearing:
 *
 * 1. structure + header + signature + claims shape -> `invalid`
 * 2. `exp` (with {@link EXP_LEEWAY_SECONDS} leeway)  -> `expired`
 * 3. purpose binding                                 -> `wrong_purpose`
 * 4. single-use ledger (`store.isUsed`)              -> `used`
 *
 * A tampered token never reaches the store lookup. Success does NOT consume
 * the token — callers `markUsed(claims.jti, secondsUntilExp)` only after the
 * patient's action commits (consumed on submission, not on page view).
 */
export async function verifyPatientToken(
  token: string,
  expectedPurpose: TokenPurpose,
  secret: string,
  store: UsedTokenStore,
  now: Date = new Date(),
): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "invalid" };
  const [headerText, payloadText, signatureText] = parts as [
    string,
    string,
    string,
  ];

  const headerBytes = fromBase64Url(headerText);
  const payloadBytes = fromBase64Url(payloadText);
  const signatureBytes = fromBase64Url(signatureText);
  if (!headerBytes || !payloadBytes || !signatureBytes) {
    return { ok: false, reason: "invalid" };
  }

  // The header must be exactly { alg: 'HS256', typ: 'JWT' } — nothing else
  // verifies, which forecloses `alg: none` and downgrade constructions.
  const header = parseJson(headerBytes);
  if (
    header === null ||
    typeof header !== "object" ||
    Array.isArray(header) ||
    Object.keys(header).length !== 2 ||
    (header as Record<string, unknown>).alg !== FIXED_HEADER.alg ||
    (header as Record<string, unknown>).typ !== FIXED_HEADER.typ
  ) {
    return { ok: false, reason: "invalid" };
  }

  // Constant-time by construction: crypto.subtle.verify compares the MAC
  // internally. Never decode-and-compare signature bytes with `===`.
  const key = await importSecret(secret, "verify");
  const signatureValid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes as BufferSource,
    encoder.encode(`${headerText}.${payloadText}`) as BufferSource,
  );
  if (!signatureValid) return { ok: false, reason: "invalid" };

  const parsed = claimsSchema.safeParse(parseJson(payloadBytes));
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const claims = parsed.data;

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (nowSeconds > claims.exp + EXP_LEEWAY_SECONDS) {
    return { ok: false, reason: "expired" };
  }

  if (claims.purpose !== expectedPurpose) {
    return { ok: false, reason: "wrong_purpose" };
  }

  if (await store.isUsed(claims.jti)) {
    return { ok: false, reason: "used" };
  }

  return { ok: true, claims };
}
