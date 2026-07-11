/**
 * staffAuth unit tests (issue #68): every outcome that resolves BEFORE the
 * DB round-trip — 401s and the no-org 403 — plus the `requirePermission`
 * factory. JWTs are signed in-test with a locally generated RS256 keypair;
 * the middleware verifies against its public key (the networkless `jwtKey`
 * path). DB-dependent outcomes live in staffAuth.integration.test.ts.
 */

import { resetEnvCache, type StaffActor } from "@wellregarded/core";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/app";
import type { AppEnv } from "../src/bindings";
import { requirePermission } from "../src/middleware/staffAuth";
import { testEnv } from "./support/env";
import {
  generateTestKeys,
  signSessionToken,
  type TestKeys,
} from "./support/jwt";

let keys: TestKeys;
let strangerKeys: TestKeys;

beforeAll(async () => {
  keys = await generateTestKeys();
  strangerKeys = await generateTestKeys();
});

beforeEach(() => {
  resetEnvCache();
});

function authedEnv(overrides: Record<string, unknown> = {}) {
  return testEnv({ CLERK_JWKS_PUBLIC_KEY: keys.publicKeyPem, ...overrides });
}

async function getMe(
  init?: RequestInit,
  envOverrides?: Record<string, unknown>,
) {
  return app.request("/api/me", init, authedEnv(envOverrides));
}

describe("staffAuth — 401 unauthenticated", () => {
  it("no token", async () => {
    const res = await getMe();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("garbage token", async () => {
    const res = await getMe({
      headers: { Authorization: "Bearer not.a.jwt" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("expired token", async () => {
    const token = await signSessionToken(keys, {
      claims: { o: { id: "org_x", rol: "admin" } },
      expiresInSeconds: -60,
    });
    const res = await getMe({ headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  it("token signed with the wrong key", async () => {
    const token = await signSessionToken(strangerKeys, {
      claims: { o: { id: "org_x", rol: "admin" } },
    });
    const res = await getMe({ headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  it("malformed Authorization scheme never falls back to cookies", async () => {
    const token = await signSessionToken(keys, {
      claims: { o: { id: "org_x", rol: "admin" } },
    });
    const res = await getMe({
      headers: {
        Authorization: `Basic ${token}`,
        Cookie: `__session=${token}`,
      },
    });
    expect(res.status).toBe(401);
  });

  it("wrong azp when CLERK_AUTHORIZED_PARTIES is configured", async () => {
    const token = await signSessionToken(keys, {
      claims: {
        o: { id: "org_x", rol: "admin" },
        azp: "https://evil.example.com",
      },
    });
    const res = await getMe(
      { headers: { Authorization: `Bearer ${token}` } },
      { CLERK_AUTHORIZED_PARTIES: "https://dashboard.example.com" },
    );
    expect(res.status).toBe(401);
  });
});

describe("staffAuth — 403 before any DB lookup", () => {
  it("valid token with no org claim → no_org", async () => {
    const token = await signSessionToken(keys);
    const res = await getMe({ headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", reason: "no_org" });
  });
});

describe("misconfiguration", () => {
  it("missing CLERK_JWKS_PUBLIC_KEY → 500, not an auth status", async () => {
    const res = await app.request("/api/me", undefined, testEnv());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
  });
});

describe("requirePermission (issue #68 requirement 4)", () => {
  function appWithActor(role: StaffActor["role"]) {
    const actor: StaffActor = {
      type: "staff",
      staffId: "staff-1",
      practiceId: "practice-1",
      role,
      locationId: null,
    };
    const testApp = new Hono<AppEnv>();
    testApp.use("*", async (c, next) => {
      c.set("actor", actor);
      await next();
    });
    testApp.get("/settings", requirePermission("manage_settings"), (c) =>
      c.json({ ok: true }),
    );
    return testApp;
  }

  it("200 for an owner actor", async () => {
    const res = await appWithActor("owner").request("/settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("403 permission for a front_desk actor", async () => {
    const res = await appWithActor("front_desk").request("/settings");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "forbidden",
      reason: "permission",
    });
  });
});

describe("healthz", () => {
  it("responds without auth", async () => {
    const res = await app.request("/healthz", undefined, testEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, environment: "local" });
  });
});
