/**
 * Locally signed Clerk-shaped session JWTs (issue #68's testing strategy):
 * generate an RS256 keypair per test file, configure the middleware with
 * the public key via CLERK_JWKS_PUBLIC_KEY (the networkless `jwtKey`
 * path), and sign tokens with the private key — no Clerk account, no
 * network, fully deterministic.
 */

import { exportSPKI, generateKeyPair, type JWTPayload, SignJWT } from "jose";

export interface TestKeys {
  /** PEM (SPKI) public key — goes in env.CLERK_JWKS_PUBLIC_KEY. */
  publicKeyPem: string;
  privateKey: CryptoKey;
}

export async function generateTestKeys(): Promise<TestKeys> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  return { publicKeyPem: await exportSPKI(publicKey), privateKey };
}

export interface SessionTokenOptions {
  /** Clerk user id — the JWT `sub`. */
  sub?: string;
  /** Extra claims merged over the defaults (e.g. `o`, `org_id`, `azp`). */
  claims?: JWTPayload;
  /** Expiry, seconds from now. Negative = already expired. */
  expiresInSeconds?: number;
}

/** Sign a session token shaped like Clerk's (iss/sub/sid/iat/nbf/exp). */
export async function signSessionToken(
  keys: TestKeys,
  options: SessionTokenOptions = {},
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresIn = options.expiresInSeconds ?? 300;
  const jwt = new SignJWT({
    iss: "https://clerk.test.example.com",
    sid: "sess_test_123",
    v: 2,
    ...options.claims,
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setSubject(options.sub ?? "user_test_1")
    .setIssuedAt(nowSeconds - 10)
    .setNotBefore(nowSeconds - 10)
    .setExpirationTime(nowSeconds + expiresIn);
  return jwt.sign(keys.privateKey);
}
