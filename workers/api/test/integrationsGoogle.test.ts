/**
 * Google connect-flow unit tests (issue #118): every outcome that resolves
 * BEFORE any DB round-trip — the permission gate, the authorization-URL
 * construction (PKCE + signed state + offline/consent recipe), and the
 * callback's CSRF rejections. HYPERDRIVE points at UNREACHABLE_DB, so any
 * path that (incorrectly) queried would surface as a 500. The full
 * connect → callback → row cycle lives in
 * integrationsGoogle.integration.test.ts.
 */

import {
  createLogger,
  resetEnvCache,
  type StaffActor,
} from "@wellregarded/core";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import type { AppEnv } from "../src/bindings";
import {
  OAUTH_STATE_TTL_SECONDS,
  signOauthState,
  verifyOauthState,
} from "../src/lib/oauthState";
import { googleIntegrationRoutes } from "../src/routes/integrations/google";
import { TEST_OAUTH_STATE_SECRET, type TestEnv, testEnv } from "./support/env";
import { FakeKv } from "./support/fakeKv";

const OWNER: StaffActor = {
  type: "staff",
  staffId: "2a629e44-6ca6-4c94-8d90-2b3c4d5e6f70",
  practiceId: "1f519d33-5b95-4b83-9c8f-1a2b3c4d5e6f",
  role: "owner",
  locationId: null,
};

function appWithActor(actor: StaffActor = OWNER) {
  const testApp = new Hono<AppEnv>();
  testApp.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("logger", createLogger({ worker: "api", requestId: "test" }));
    await next();
  });
  testApp.route("/integrations/google", googleIntegrationRoutes);
  return testApp;
}

function googleEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  return testEnv({
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    GOOGLE_OAUTH_STATE_SECRET: TEST_OAUTH_STATE_SECRET,
    ...overrides,
  });
}

/** RFC 7636 S256, mirrored for assertion parity with the route. */
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

beforeEach(() => {
  resetEnvCache();
});

describe("permission gate — manage_settings", () => {
  it.each([
    ["front_desk", "GET", "/integrations/google"],
    ["front_desk", "GET", "/integrations/google/connect"],
    ["provider", "GET", "/integrations/google/callback"],
    ["external_partner", "POST", "/integrations/google/disconnect"],
    ["marketing", "GET", "/integrations/google/connect"],
  ] as const)("%s is denied %s %s → 403", async (role, method, path) => {
    const res = await appWithActor({ ...OWNER, role }).request(
      path,
      { method },
      googleEnv(),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "forbidden",
      reason: "permission",
    });
  });
});

describe("GET /integrations/google/connect", () => {
  it("302s to Google with PKCE, offline+consent, and a bound signed state", async () => {
    const env = googleEnv();
    const res = await appWithActor().request(
      "/integrations/google/connect",
      undefined,
      env,
    );
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.pathname).toBe("/o/oauth2/v2/auth");
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/business.manage",
    );
    // Required to reliably receive a refresh token (ADR 0002 §4).
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("prompt")).toBe("consent");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost/integrations/google/callback",
    );

    // The state verifies and is bound to THIS practice + staff.
    const state = location.searchParams.get("state") ?? "";
    const verified = await verifyOauthState(state, TEST_OAUTH_STATE_SECRET);
    if (!verified.ok) throw new Error("state must verify");
    expect(verified.payload.practiceId).toBe(OWNER.practiceId);
    expect(verified.payload.staffId).toBe(OWNER.staffId);

    // The verifier lives in KV under the state's nonce with the state TTL,
    // and the challenge in the URL is its S256.
    const kv = env.OAUTH_STATE;
    expect(kv.onlyKey()).toBe(`google_oauth:${verified.payload.nonce}`);
    const record = JSON.parse((await kv.get(kv.onlyKey())) ?? "") as {
      verifier: string;
      practiceId: string;
      staffId: string;
    };
    expect(record.practiceId).toBe(OWNER.practiceId);
    expect(record.staffId).toBe(OWNER.staffId);
    expect(location.searchParams.get("code_challenge")).toBe(
      await s256(record.verifier),
    );
  });

  it("two connects mint distinct verifiers and nonces", async () => {
    const env = googleEnv();
    const app = appWithActor();
    const first = await app.request(
      "/integrations/google/connect",
      undefined,
      env,
    );
    const second = await app.request(
      "/integrations/google/connect",
      undefined,
      env,
    );
    const challenge = (res: Response) =>
      new URL(res.headers.get("Location") ?? "").searchParams.get(
        "code_challenge",
      );
    expect(challenge(first)).not.toBe(challenge(second));
    expect(env.OAUTH_STATE.entries.size).toBe(2);
  });

  it("500s with an actionable message when GOOGLE_CLIENT_ID is unset", async () => {
    const app = new Hono<AppEnv>();
    app.onError((error, c) => c.json({ message: error.message }, 500));
    app.use("*", async (c, next) => {
      c.set("actor", OWNER);
      await next();
    });
    app.route("/integrations/google", googleIntegrationRoutes);
    const res = await app.request(
      "/integrations/google/connect",
      undefined,
      testEnv({ GOOGLE_OAUTH_STATE_SECRET: TEST_OAUTH_STATE_SECRET }),
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as { message: string }).message).toMatch(
      /GOOGLE_CLIENT_ID/,
    );
  });
});

describe("GET /integrations/google/callback — CSRF rejections (no DB, no Google)", () => {
  function callback(env: TestEnv, params: Record<string, string>) {
    return appWithActor().request(
      `/integrations/google/callback?${new URLSearchParams(params)}`,
      undefined,
      env,
    );
  }

  function redirectError(res: Response): string | null {
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("Location") ?? "");
    expect(url.origin).toBe("http://localhost:5173");
    expect(url.pathname).toBe("/settings");
    return url.searchParams.get("error");
  }

  it("user denied at Google → google_access_denied", async () => {
    const res = await callback(googleEnv(), { error: "access_denied" });
    expect(redirectError(res)).toBe("google_access_denied");
  });

  it("missing code or state → google_invalid_callback", async () => {
    expect(redirectError(await callback(googleEnv(), { code: "x" }))).toBe(
      "google_invalid_callback",
    );
    expect(redirectError(await callback(googleEnv(), { state: "x" }))).toBe(
      "google_invalid_callback",
    );
  });

  it("tampered state → google_invalid_state", async () => {
    const state = await signOauthState(
      { practiceId: OWNER.practiceId, staffId: OWNER.staffId, nonce: "n" },
      TEST_OAUTH_STATE_SECRET,
    );
    const res = await callback(googleEnv(), {
      code: "c",
      state: `${state}tampered`,
    });
    expect(redirectError(res)).toBe("google_invalid_state");
  });

  it("expired state → google_state_expired", async () => {
    const past = new Date(Date.now() - (OAUTH_STATE_TTL_SECONDS + 60) * 1000);
    const state = await signOauthState(
      { practiceId: OWNER.practiceId, staffId: OWNER.staffId, nonce: "n" },
      TEST_OAUTH_STATE_SECRET,
      past,
    );
    const res = await callback(googleEnv(), { code: "c", state });
    expect(redirectError(res)).toBe("google_state_expired");
  });

  it("state minted for ANOTHER practice/staff → google_state_mismatch", async () => {
    const state = await signOauthState(
      {
        practiceId: "99999999-9999-4999-8999-999999999999",
        staffId: OWNER.staffId,
        nonce: "n",
      },
      TEST_OAUTH_STATE_SECRET,
    );
    const res = await callback(googleEnv(), { code: "c", state });
    expect(redirectError(res)).toBe("google_state_mismatch");
  });

  it("valid state whose nonce is not in KV (reused/expired) → google_state_reused", async () => {
    const state = await signOauthState(
      {
        practiceId: OWNER.practiceId,
        staffId: OWNER.staffId,
        nonce: crypto.randomUUID(),
      },
      TEST_OAUTH_STATE_SECRET,
    );
    const res = await callback(googleEnv(), { code: "c", state });
    expect(redirectError(res)).toBe("google_state_reused");
  });

  it("KV record bound to a different staff session → google_state_mismatch", async () => {
    const nonce = crypto.randomUUID();
    const kv = new FakeKv();
    await kv.put(
      `google_oauth:${nonce}`,
      JSON.stringify({
        verifier: "v",
        practiceId: OWNER.practiceId,
        staffId: "88888888-8888-4888-8888-888888888888",
      }),
    );
    const state = await signOauthState(
      { practiceId: OWNER.practiceId, staffId: OWNER.staffId, nonce },
      TEST_OAUTH_STATE_SECRET,
    );
    const res = await callback(googleEnv({ OAUTH_STATE: kv }), {
      code: "c",
      state,
    });
    expect(redirectError(res)).toBe("google_state_mismatch");
    // Consumed on read even when rejected — single-use either way.
    expect(kv.entries.size).toBe(0);
  });
});
