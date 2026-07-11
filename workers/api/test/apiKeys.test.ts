/**
 * API key auth unit tests (issue #81): every outcome that resolves BEFORE
 * any DB round-trip. The env's HYPERDRIVE points at UNREACHABLE_DB, so any
 * code path that (incorrectly) queried would surface as a 500 — a 401/403/
 * 400 here proves no DB work happened. DB-dependent outcomes live in
 * apiKeys.integration.test.ts.
 */

import { resetEnvCache, type StaffActor } from "@wellregarded/core";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/app";
import type { AppEnv } from "../src/bindings";
import { apiKeyRoutes } from "../src/routes/apiKeys";
import { testEnv } from "./support/env";

beforeEach(() => {
  resetEnvCache();
});

async function getProofMe(init?: RequestInit) {
  return app.request("/proof/me", init, testEnv());
}

describe("apiKeyAuth — 401 without a DB query", () => {
  it("no key at all", async () => {
    const res = await getProofMe();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_api_key" });
  });

  it("garbage bearer token (not key-shaped)", async () => {
    const res = await getProofMe({
      headers: { Authorization: "Bearer not-a-key" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_api_key" });
  });

  it("wrong prefix (zk_…) is rejected by the shape check", async () => {
    // "zk", not Stripe-style "sk": GitHub push protection rejects anything
    // matching that pattern, even fake fixtures.
    const res = await getProofMe({
      headers: { Authorization: `Bearer zk_live_${"a".repeat(43)}` },
    });
    expect(res.status).toBe(401);
  });

  it("malformed Authorization scheme never falls back to the query param", async () => {
    const res = await app.request(
      `/proof/me?key=pk_live_${"a".repeat(43)}`,
      { headers: { Authorization: "Basic something" } },
      testEnv(),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_api_key" });
  });

  it("malformed query-param key", async () => {
    const res = await app.request("/proof/me?key=oops", undefined, testEnv());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_api_key" });
  });
});

describe("management endpoints — permission gate (matrix: owner only)", () => {
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
    testApp.route("/api-keys", apiKeyRoutes);
    return testApp;
  }

  it("office_manager is denied manage_api_keys → 403", async () => {
    const res = await appWithActor("office_manager").request(
      "/api-keys",
      undefined,
      testEnv(),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "forbidden",
      reason: "permission",
    });
  });

  it("every non-owner role is denied on create", async () => {
    for (const role of [
      "office_manager",
      "front_desk",
      "marketing",
      "provider",
      "multi_location_admin",
      "external_partner",
    ] as const) {
      const res = await appWithActor(role).request(
        "/api-keys",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "x", environment: "live" }),
        },
        testEnv(),
      );
      expect(res.status).toBe(403);
    }
  });

  it("owner with an invalid body → 400 before any DB work", async () => {
    const res = await appWithActor("owner").request(
      "/api-keys",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "", environment: "prod" }),
      },
      testEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  it("owner revoking a non-uuid id → 404 before any DB work", async () => {
    const res = await appWithActor("owner").request(
      "/api-keys/not-a-uuid/revoke",
      { method: "POST" },
      testEnv(),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
