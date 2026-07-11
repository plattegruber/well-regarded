/**
 * API key integration tests (issue #81): the middleware and management
 * endpoints through `app.request()` against a real Postgres via
 * packages/db's template-clone harness, with rows seeded by Epic #3's
 * factories and staff callers authenticated with locally signed JWTs.
 */

import { hashApiKey, resetEnvCache } from "@wellregarded/core";
import { schema } from "@wellregarded/db";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  apiKey,
  practice,
  staffMember,
} from "../../../packages/db/test/factories.js";
import { setupTestDb } from "../../../packages/db/test/harness.js";
import {
  requireDatabaseUrl,
  withDatabase,
} from "../../../packages/db/test/support.js";
import { app } from "../src/app";
import { testEnv } from "./support/env";
import {
  generateTestKeys,
  signSessionToken,
  type TestKeys,
} from "./support/jwt";

const { apiKeys, auditLog } = schema;

const t = setupTestDb();

let keys: TestKeys;

beforeAll(async () => {
  keys = await generateTestKeys();
});

beforeEach(() => {
  resetEnvCache();
});

function env() {
  return testEnv({
    HYPERDRIVE: {
      connectionString: withDatabase(requireDatabaseUrl(), t.databaseName),
    },
    CLERK_JWKS_PUBLIC_KEY: keys.publicKeyPem,
  });
}

async function proofMe(init?: RequestInit, path = "/proof/me") {
  return app.request(path, init, env());
}

/** A practice plus an authenticated staff member of the given role. */
async function staffCaller(role: "owner" | "office_manager" = "owner") {
  const n = `${role}_${Math.random().toString(36).slice(2, 10)}`;
  const p = await practice(t.db);
  const staff = await staffMember(t.db, {
    practiceId: p.id,
    clerkUserId: `user_${n}`,
    role,
  });
  const token = await signSessionToken(keys, {
    sub: staff.clerkUserId,
    claims: { o: { id: p.clerkOrgId, rol: "member" } },
  });
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  return { practice: p, staff, headers };
}

async function auditRows(practiceId: string, action: string) {
  return t.db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.practiceId, practiceId), eq(auditLog.action, action)),
    );
}

describe("apiKeyAuth middleware (issue #81)", () => {
  it("valid live key in the Authorization header → apiActor populated", async () => {
    const p = await practice(t.db);
    const created = await apiKey(t.db, { practiceId: p.id });

    const res = await proofMe({
      headers: { Authorization: `Bearer ${created.key}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      actor: {
        type: "api_key",
        practiceId: p.id,
        keyId: created.id,
        environment: "live",
      },
    });
  });

  it("test keys authenticate identically but are flagged on the actor", async () => {
    const created = await apiKey(t.db, { environment: "test" });
    const res = await proofMe({
      headers: { Authorization: `Bearer ${created.key}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actor: { environment: string } };
    expect(body.actor.environment).toBe("test");
  });

  it("?key= query fallback works (script-tag embeds)", async () => {
    const created = await apiKey(t.db);
    const res = await proofMe(
      undefined,
      `/proof/me?key=${encodeURIComponent(created.key)}`,
    );
    expect(res.status).toBe(200);
  });

  it("revoked key → 401, same body as unknown", async () => {
    const created = await apiKey(t.db, { revokedAt: new Date() });
    const revokedRes = await proofMe({
      headers: { Authorization: `Bearer ${created.key}` },
    });
    const unknownRes = await proofMe({
      headers: { Authorization: `Bearer pk_live_${"a".repeat(43)}` },
    });
    expect(revokedRes.status).toBe(401);
    expect(unknownRes.status).toBe(401);
    // Never distinguish unknown vs revoked in the response.
    expect(await revokedRes.json()).toEqual(await unknownRes.json());
  });

  it("a successful request touches last_used_at", async () => {
    const created = await apiKey(t.db);
    expect(created.lastUsedAt).toBeNull();

    const before = new Date();
    const res = await proofMe({
      headers: { Authorization: `Bearer ${created.key}` },
    });
    expect(res.status).toBe(200);

    const [row] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, created.id));
    expect(row?.lastUsedAt).not.toBeNull();
    expect(row?.lastUsedAt?.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
  });

  it("a rejected key never touches last_used_at", async () => {
    const created = await apiKey(t.db, { revokedAt: new Date() });
    await proofMe({ headers: { Authorization: `Bearer ${created.key}` } });
    const [row] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, created.id));
    expect(row?.lastUsedAt).toBeNull();
  });
});

describe("POST /api/api-keys (create)", () => {
  it("owner creates a key; plaintext appears exactly once, DB stores only the hash", async () => {
    const { practice: p, staff, headers } = await staffCaller("owner");

    const res = await app.request(
      "/api/api-keys",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Website embed", environment: "live" }),
      },
      env(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      key: string;
      name: string;
      environment: string;
      last4: string;
      prefix: string;
    };
    expect(body.key).toMatch(/^pk_live_[A-Za-z0-9_-]{43}$/);
    expect(body.name).toBe("Website embed");
    expect(body.prefix).toBe("pk_live_");
    expect(body.last4).toBe(body.key.slice(-4));

    // The row stores the SHA-256 of the returned plaintext — and never the
    // plaintext itself, anywhere.
    const [row] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, body.id));
    expect(row?.keyHash).toBe(await hashApiKey(body.key));
    expect(row?.createdBy).toBe(staff.id);
    expect(row?.practiceId).toBe(p.id);
    expect(JSON.stringify(row)).not.toContain(body.key);

    // The freshly created key authenticates against the proof group.
    const me = await proofMe({
      headers: { Authorization: `Bearer ${body.key}` },
    });
    expect(me.status).toBe(200);

    // Audited with the staff actor.
    const rows = await auditRows(p.id, "api_key.created");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorType).toBe("staff");
    expect(rows[0]?.actorId).toBe(staff.id);
    expect(rows[0]?.entityType).toBe("api_keys");
    expect(rows[0]?.entityId).toBe(body.id);
    // Audit payload never contains the plaintext or the hash.
    const payloadJson = JSON.stringify(rows[0]?.payload);
    expect(payloadJson).not.toContain(body.key);
    expect(payloadJson).not.toContain(row?.keyHash);
  });

  it("office_manager → 403 permission (matrix: owner only)", async () => {
    const { practice: p, headers } = await staffCaller("office_manager");
    const res = await app.request(
      "/api/api-keys",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Nope", environment: "live" }),
      },
      env(),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "forbidden",
      reason: "permission",
    });
    expect(await auditRows(p.id, "api_key.created")).toHaveLength(0);
  });
});

describe("GET /api/api-keys (list)", () => {
  it("lists the practice's keys — display fields only, never hashes or plaintext", async () => {
    const { practice: p, headers } = await staffCaller("owner");
    const live = await apiKey(t.db, { practiceId: p.id, name: "Live key" });
    const revoked = await apiKey(t.db, {
      practiceId: p.id,
      environment: "test",
      name: "Old key",
      revokedAt: new Date(),
    });
    // Another practice's key must never appear.
    await apiKey(t.db, { name: "Other practice" });

    const res = await app.request("/api/api-keys", { headers }, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      apiKeys: Array<Record<string, unknown>>;
    };
    expect(body.apiKeys).toHaveLength(2);

    const listed = new Map(body.apiKeys.map((k) => [k.id, k]));
    expect(listed.get(live.id)).toMatchObject({
      name: "Live key",
      environment: "live",
      prefix: "pk_live_",
      last4: live.last4,
      revokedAt: null,
    });
    expect(listed.get(revoked.id)).toMatchObject({
      environment: "test",
      prefix: "pk_test_",
    });
    expect(listed.get(revoked.id)?.revokedAt).not.toBeNull();

    const raw = JSON.stringify(body);
    expect(raw).not.toContain(live.keyHash);
    expect(raw).not.toContain(revoked.keyHash);
    expect(raw).not.toContain(live.key);
    expect(raw).not.toContain(revoked.key);
  });
});

describe("POST /api/api-keys/:id/revoke", () => {
  it("revokes: stamps revoked_at, key stops resolving immediately, audited", async () => {
    const { practice: p, staff, headers } = await staffCaller("owner");
    const created = await apiKey(t.db, { practiceId: p.id });

    const res = await app.request(
      `/api/api-keys/${created.id}/revoke`,
      { method: "POST", headers },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; revokedAt: string };
    expect(body.id).toBe(created.id);
    expect(body.revokedAt).not.toBeNull();

    // Revocation is immediate — no cache, next lookup misses.
    const me = await proofMe({
      headers: { Authorization: `Bearer ${created.key}` },
    });
    expect(me.status).toBe(401);

    const rows = await auditRows(p.id, "api_key.revoked");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorId).toBe(staff.id);
    expect(rows[0]?.entityId).toBe(created.id);
  });

  it("is idempotent: a second revoke returns the original timestamp, no second audit row", async () => {
    const { practice: p, headers } = await staffCaller("owner");
    const created = await apiKey(t.db, { practiceId: p.id });

    const first = await app.request(
      `/api/api-keys/${created.id}/revoke`,
      { method: "POST", headers },
      env(),
    );
    const second = await app.request(
      `/api/api-keys/${created.id}/revoke`,
      { method: "POST", headers },
      env(),
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { revokedAt: string };
    const secondBody = (await second.json()) as { revokedAt: string };
    expect(secondBody.revokedAt).toBe(firstBody.revokedAt);
    expect(await auditRows(p.id, "api_key.revoked")).toHaveLength(1);
  });

  it("cross-practice: practice B's owner cannot revoke practice A's key", async () => {
    const keyA = await apiKey(t.db); // practice A
    const { headers } = await staffCaller("owner"); // practice B

    const res = await app.request(
      `/api/api-keys/${keyA.id}/revoke`,
      { method: "POST", headers },
      env(),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });

    // The key is untouched and still resolves.
    const me = await proofMe({
      headers: { Authorization: `Bearer ${keyA.key}` },
    });
    expect(me.status).toBe(200);
  });
});
