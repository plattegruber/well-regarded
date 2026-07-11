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
    if (!granted) throw new Error("expected exchange to succeed");
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
    if (!granted) throw new Error("expected exchange to succeed");

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
