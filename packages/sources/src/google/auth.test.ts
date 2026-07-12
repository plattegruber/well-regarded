/**
 * Unit tests for the Google OAuth helpers (issue #118): code exchange,
 * clock-skew expiry, single-flight refresh, the `invalid_grant` →
 * `needs_reauth` path, and best-effort revocation. All HTTP goes to the
 * in-process fake GBP server via injected fetch — no network.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createGoogleAccessTokenProvider,
  exchangeAuthorizationCode,
  GoogleOAuthError,
  NeedsReauthError,
  revokeGoogleToken,
} from "./auth.js";
import { createFakeGbp } from "./fake/index.js";

// The fake serves every Google host from one origin under prefixed paths
// (`/oauth/token`, not bare `/token`) — same URLs the GOOGLE_OAUTH_*_URL
// env vars would carry when pointed at the fake.
const REAL_TOKEN_URL = "http://fake-gbp.local/oauth/token";
const REAL_REVOKE_URL = "http://fake-gbp.local/oauth/revoke";

/** Fake-backed fetch that also counts token-endpoint calls. */
function fakeFetch(app: {
  fetch: (req: Request) => Response | Promise<Response>;
}) {
  const calls: string[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
    return app.fetch(request.clone());
  };
  return { doFetch, calls };
}

function config(app: Parameters<typeof fakeFetch>[0]) {
  const { doFetch, calls } = fakeFetch(app);
  return {
    calls,
    config: {
      tokenUrl: REAL_TOKEN_URL,
      clientId: "client",
      clientSecret: "secret",
      fetch: doFetch,
    },
  };
}

describe("exchangeAuthorizationCode", () => {
  it("returns the granted tokens", async () => {
    const { app, store } = createFakeGbp();
    const { config: cfg } = config(app);
    const tokens = await exchangeAuthorizationCode(cfg, {
      code: store.issueAuthCode(),
      codeVerifier: "verifier-verifier-verifier-verifier-verifi",
      redirectUri: "http://localhost/callback",
    });
    expect(tokens.accessToken).toBe("fake-access-token-1");
    expect(tokens.refreshToken).toBe("fake-refresh-token-1");
    expect(tokens.expiresIn).toBe(3600);
  });

  it("throws a typed GoogleOAuthError on a bad code", async () => {
    const { app } = createFakeGbp();
    const { config: cfg } = config(app);
    await expect(
      exchangeAuthorizationCode(cfg, {
        code: "bogus",
        codeVerifier: "v",
        redirectUri: "http://localhost/callback",
      }),
    ).rejects.toMatchObject({
      name: "GoogleOAuthError",
      status: 400,
      code: "invalid_grant",
    });
  });
});

describe("createGoogleAccessTokenProvider", () => {
  function connected(store: ReturnType<typeof createFakeGbp>["store"]) {
    const granted = store.exchangeAuthCode(store.issueAuthCode());
    if (!granted?.refreshToken) throw new Error("expected refresh token");
    return { id: "conn-1", refreshToken: granted.refreshToken };
  }

  it("caches until expiry minus the 60s skew, then refreshes", async () => {
    let nowMs = Date.parse("2026-07-01T00:00:00Z");
    const { app, store } = createFakeGbp();
    store.accessTokenTtlSeconds = 3600;
    const connection = connected(store);
    const { config: cfg, calls } = config(app);
    const provider = createGoogleAccessTokenProvider({
      config: cfg,
      now: () => nowMs,
    });

    const first = await provider.getAccessToken(connection);
    expect(calls).toHaveLength(1);

    // Well inside the lifetime: cache hit, no HTTP.
    nowMs += 30 * 60 * 1000;
    expect(await provider.getAccessToken(connection)).toBe(first);
    expect(calls).toHaveLength(1);

    // 30s before expiry — inside the skew window → treated as expired.
    nowMs += 3600 * 1000 - 30 * 60 * 1000 - 30 * 1000;
    const second = await provider.getAccessToken(connection);
    expect(second).not.toBe(first);
    expect(calls).toHaveLength(2);
  });

  it("single-flights concurrent refreshes into one HTTP call", async () => {
    const { app, store } = createFakeGbp();
    const connection = connected(store);
    const { config: cfg, calls } = config(app);
    const provider = createGoogleAccessTokenProvider({ config: cfg });

    const [a, b, c] = await Promise.all([
      provider.getAccessToken(connection),
      provider.getAccessToken(connection),
      provider.getAccessToken(connection),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(calls).toHaveLength(1);
  });

  it("invalid_grant → onInvalidGrant fires once, NeedsReauthError thrown", async () => {
    const { app, store } = createFakeGbp();
    const connection = connected(store);
    store.revokeRefreshToken(connection.refreshToken);
    const { config: cfg, calls } = config(app);
    const onInvalidGrant = vi.fn().mockResolvedValue(undefined);
    const provider = createGoogleAccessTokenProvider({
      config: cfg,
      onInvalidGrant,
    });

    await expect(provider.getAccessToken(connection)).rejects.toBeInstanceOf(
      NeedsReauthError,
    );
    expect(onInvalidGrant).toHaveBeenCalledExactlyOnceWith("conn-1");
    expect(calls).toHaveLength(1);
  });

  it("transient failures throw GoogleOAuthError and never mark needs_reauth", async () => {
    const { app, store } = createFakeGbp();
    const connection = connected(store);
    store.failNext("POST /oauth/token", { status: 503 });
    const { config: cfg } = config(app);
    const onInvalidGrant = vi.fn();
    const provider = createGoogleAccessTokenProvider({
      config: cfg,
      onInvalidGrant,
    });

    await expect(provider.getAccessToken(connection)).rejects.toBeInstanceOf(
      GoogleOAuthError,
    );
    expect(onInvalidGrant).not.toHaveBeenCalled();

    // The failure was not cached: the next call refreshes successfully.
    await expect(provider.getAccessToken(connection)).resolves.toMatch(
      /^fake-access-token-/,
    );
  });

  it("a changed refresh token (re-auth) bypasses the stale cache entry", async () => {
    const { app, store } = createFakeGbp();
    const connection = connected(store);
    const { config: cfg, calls } = config(app);
    const provider = createGoogleAccessTokenProvider({ config: cfg });

    const first = await provider.getAccessToken(connection);
    const reauthed = store.exchangeAuthCode(store.issueAuthCode());
    if (!reauthed?.refreshToken) throw new Error("expected refresh token");
    const second = await provider.getAccessToken({
      id: connection.id,
      refreshToken: reauthed.refreshToken,
    });
    expect(second).not.toBe(first);
    expect(calls).toHaveLength(2);
  });

  it("invalidate() drops the cache entry", async () => {
    const { app, store } = createFakeGbp();
    const connection = connected(store);
    const { config: cfg, calls } = config(app);
    const provider = createGoogleAccessTokenProvider({ config: cfg });

    await provider.getAccessToken(connection);
    provider.invalidate(connection.id);
    await provider.getAccessToken(connection);
    expect(calls).toHaveLength(2);
  });
});

describe("revokeGoogleToken", () => {
  it("returns true when the fake acknowledges", async () => {
    const { app, store } = createFakeGbp();
    const granted = store.exchangeAuthCode(store.issueAuthCode());
    if (!granted?.refreshToken) throw new Error("expected refresh token");
    const { doFetch } = fakeFetch(app);
    await expect(
      revokeGoogleToken(
        { revokeUrl: REAL_REVOKE_URL, fetch: doFetch },
        granted.refreshToken,
      ),
    ).resolves.toBe(true);
    expect(store.isValidRefreshToken(granted.refreshToken)).toBe(false);
  });

  it("never throws — unknown token and network failure both return false", async () => {
    const { app } = createFakeGbp();
    const { doFetch } = fakeFetch(app);
    await expect(
      revokeGoogleToken(
        { revokeUrl: REAL_REVOKE_URL, fetch: doFetch },
        "never-issued",
      ),
    ).resolves.toBe(false);

    const failingFetch: typeof fetch = async () => {
      throw new TypeError("network down");
    };
    await expect(
      revokeGoogleToken(
        { revokeUrl: REAL_REVOKE_URL, fetch: failingFetch },
        "whatever",
      ),
    ).resolves.toBe(false);
  });
});
