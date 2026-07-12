import { describe, expect, it } from "vitest";

import { createFakeGbp, GBP_OAUTH_SCOPE } from "./app.js";
import { FakeGbpStore } from "./store.js";
import type { OauthTokenResponse } from "./types.js";

async function tokenRequest(
  app: ReturnType<typeof createFakeGbp>["app"],
  params: Record<string, string>,
): Promise<Response> {
  return app.request("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

describe("POST /oauth/token", () => {
  it("exchanges an auth code for deterministic access + refresh tokens", async () => {
    const { app, store } = createFakeGbp();
    const code = store.issueAuthCode();

    const res = await tokenRequest(app, {
      grant_type: "authorization_code",
      code,
      client_id: "client",
      client_secret: "secret",
      redirect_uri: "http://localhost/callback",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as OauthTokenResponse;
    expect(body).toEqual({
      access_token: "fake-access-token-1",
      expires_in: 3600,
      refresh_token: "fake-refresh-token-1",
      scope: GBP_OAUTH_SCOPE,
      token_type: "Bearer",
    });
  });

  it("issues access tokens that authorize data endpoints", async () => {
    const { app, store } = createFakeGbp();
    store.addAccount();
    const code = store.issueAuthCode();
    const res = await tokenRequest(app, {
      grant_type: "authorization_code",
      code,
    });
    const { access_token } = (await res.json()) as OauthTokenResponse;

    const accounts = await app.request("/v1/accounts", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(accounts.status).toBe(200);
  });

  it("auth codes are single-use: the second exchange gets invalid_grant", async () => {
    const { app, store } = createFakeGbp();
    const code = store.issueAuthCode();
    const params = { grant_type: "authorization_code", code };

    expect((await tokenRequest(app, params)).status).toBe(200);
    const replay = await tokenRequest(app, params);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects an unknown auth code with invalid_grant", async () => {
    const { app } = createFakeGbp();
    const res = await tokenRequest(app, {
      grant_type: "authorization_code",
      code: "not-a-real-code",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("refresh grant returns a fresh access token and no refresh_token", async () => {
    const { app, store } = createFakeGbp();
    const code = store.issueAuthCode();
    const exchange = (await (
      await tokenRequest(app, { grant_type: "authorization_code", code })
    ).json()) as OauthTokenResponse;
    const refreshToken = exchange.refresh_token;
    expect(refreshToken).toBeDefined();
    if (!refreshToken) throw new Error("unreachable");

    const res = await tokenRequest(app, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OauthTokenResponse;
    expect(body.access_token).toBe("fake-access-token-2");
    expect(body.refresh_token).toBeUndefined();
    expect(body.token_type).toBe("Bearer");
  });

  it("revoked refresh tokens get invalid_grant — the needs_reauth trigger (#118)", async () => {
    const { app, store } = createFakeGbp();
    const granted = store.exchangeAuthCode(store.issueAuthCode());
    if (!granted?.refreshToken) throw new Error("expected refresh token");
    store.revokeRefreshToken(granted.refreshToken);

    const res = await tokenRequest(app, {
      grant_type: "refresh_token",
      refresh_token: granted.refreshToken,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "invalid_grant",
      error_description: "Token has been expired or revoked.",
    });
  });

  it("rejects unknown grant types", async () => {
    const { app } = createFakeGbp();
    const res = await tokenRequest(app, { grant_type: "password" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unsupported_grant_type" });
  });

  it("honors a configured access-token TTL in expires_in", async () => {
    const store = new FakeGbpStore({ accessTokenTtlSeconds: 60 });
    const { app } = createFakeGbp(store);
    const res = await tokenRequest(app, {
      grant_type: "authorization_code",
      code: store.issueAuthCode(),
    });
    expect(((await res.json()) as OauthTokenResponse).expires_in).toBe(60);
  });
});

describe("GET /o/oauth2/v2/auth — auto-approving consent (#118)", () => {
  const AUTH_PARAMS = {
    client_id: "client",
    redirect_uri: "http://localhost:8787/api/integrations/google/callback",
    response_type: "code",
    scope: GBP_OAUTH_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state: "opaque-state",
  };

  function authRequest(
    app: ReturnType<typeof createFakeGbp>["app"],
    params: Record<string, string>,
  ) {
    return app.request(`/o/oauth2/v2/auth?${new URLSearchParams(params)}`);
  }

  it("302s back to redirect_uri with a working code and the state echoed", async () => {
    const { app, store } = createFakeGbp();
    const res = await authRequest(app, AUTH_PARAMS);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(
      AUTH_PARAMS.redirect_uri,
    );
    expect(location.searchParams.get("state")).toBe("opaque-state");

    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();
    const granted = store.exchangeAuthCode(code ?? "");
    expect(granted?.refreshToken).toMatch(/^fake-refresh-token-/);
  });

  it("withholds the refresh token without access_type=offline + prompt=consent", async () => {
    const { app, store } = createFakeGbp();
    const withoutRecipe: Record<string, string> = { ...AUTH_PARAMS };
    delete withoutRecipe.access_type;
    delete withoutRecipe.prompt;
    const res = await authRequest(app, withoutRecipe);
    expect(res.status).toBe(302);
    const code = new URL(res.headers.get("Location") ?? "").searchParams.get(
      "code",
    );
    const granted = store.exchangeAuthCode(code ?? "");
    expect(granted).toBeDefined();
    expect(granted?.refreshToken).toBeUndefined();
  });

  it("rejects a wrong response_type, missing scope, and non-S256 challenges", async () => {
    const { app } = createFakeGbp();
    for (const broken of [
      { ...AUTH_PARAMS, response_type: "token" },
      { ...AUTH_PARAMS, scope: "email" },
      {
        ...AUTH_PARAMS,
        code_challenge: "abc",
        code_challenge_method: "plain",
      },
      { ...AUTH_PARAMS, redirect_uri: "not-a-url" },
    ]) {
      expect((await authRequest(app, broken)).status).toBe(400);
    }
  });
});

describe("PKCE enforcement at the token endpoint (#118)", () => {
  /** RFC 7636 S256, mirrored from the app for assertion parity. */
  async function s256(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  const VERIFIER = "test-code-verifier-test-code-verifier-test61";

  it("exchanges only with the matching code_verifier", async () => {
    const { app, store } = createFakeGbp();
    const codeChallenge = await s256(VERIFIER);

    const wrong = await tokenRequest(app, {
      grant_type: "authorization_code",
      code: store.issueAuthCode({ codeChallenge }),
      code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier",
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });

    const missing = await tokenRequest(app, {
      grant_type: "authorization_code",
      code: store.issueAuthCode({ codeChallenge }),
    });
    expect(missing.status).toBe(400);

    const right = await tokenRequest(app, {
      grant_type: "authorization_code",
      code: store.issueAuthCode({ codeChallenge }),
      code_verifier: VERIFIER,
    });
    expect(right.status).toBe(200);
  });

  it("a failed PKCE exchange still consumes the code (single-use)", async () => {
    const { app, store } = createFakeGbp();
    const code = store.issueAuthCode({ codeChallenge: await s256(VERIFIER) });
    await tokenRequest(app, { grant_type: "authorization_code", code });
    const retry = await tokenRequest(app, {
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
    });
    expect(retry.status).toBe(400);
  });
});

describe("POST /oauth/revoke (#118 disconnect)", () => {
  it("revokes a refresh token so later refresh grants fail", async () => {
    const { app, store } = createFakeGbp();
    const granted = store.exchangeAuthCode(store.issueAuthCode());
    if (!granted?.refreshToken) throw new Error("expected refresh token");

    const res = await app.request("/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: granted.refreshToken }).toString(),
    });
    expect(res.status).toBe(200);
    expect(store.isValidRefreshToken(granted.refreshToken)).toBe(false);
    expect(store.refreshAccessToken(granted.refreshToken)).toBeUndefined();
  });

  it("unknown tokens get a 400", async () => {
    const { app } = createFakeGbp();
    const res = await app.request("/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "never-issued" }).toString(),
    });
    expect(res.status).toBe(400);
  });
});

describe("access-token expiry flow", () => {
  it("expired tokens get 401 UNAUTHENTICATED; a refresh restores access", async () => {
    let nowMs = Date.parse("2026-07-01T00:00:00Z");
    const store = new FakeGbpStore({
      accessTokenTtlSeconds: 3600,
      clock: () => nowMs,
    });
    const { app } = createFakeGbp(store);
    store.addAccount();
    const granted = store.exchangeAuthCode(store.issueAuthCode());
    if (!granted?.refreshToken) throw new Error("expected refresh token");

    const authed = (token: string) =>
      app.request("/v1/accounts", {
        headers: { Authorization: `Bearer ${token}` },
      });

    expect((await authed(granted.accessToken)).status).toBe(200);

    nowMs += 3601 * 1000; // past the TTL
    const expired = await authed(granted.accessToken);
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({
      error: { code: 401, status: "UNAUTHENTICATED" },
    });

    const refreshed = store.refreshAccessToken(granted.refreshToken);
    if (!refreshed) throw new Error("expected refresh to succeed");
    expect((await authed(refreshed.accessToken)).status).toBe(200);
  });

  it("expireAccessTokens() force-expires every outstanding token", async () => {
    const { app, store } = createFakeGbp();
    store.addAccount();
    const token = store.issueAccessToken();
    store.expireAccessTokens();

    const res = await app.request("/v1/accounts", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});
