/**
 * staffAuth integration tests (issue #68): the outcomes that depend on
 * practice/staff rows, against a real Postgres via packages/db's
 * template-clone harness. The app under test receives a fake HYPERDRIVE
 * binding pointing at this file's private database; rows are seeded with
 * Epic #3's factories.
 */

import { resetEnvCache } from "@wellregarded/core";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  location,
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

async function getMeWithToken(token: string, useCookie = false) {
  return app.request(
    "/api/me",
    {
      headers: useCookie
        ? { Cookie: `__session=${token}` }
        : { Authorization: `Bearer ${token}` },
    },
    env(),
  );
}

describe("staffAuth — DB resolution (issue #68)", () => {
  it("org claim not in our DB → 403 unknown_org (webhook sync lag)", async () => {
    const token = await signSessionToken(keys, {
      claims: { o: { id: "org_never_synced", rol: "admin" } },
    });
    const res = await getMeWithToken(token);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "forbidden",
      reason: "unknown_org",
    });
  });

  it("practice exists but the user has no staff row → same unknown_org (no leak)", async () => {
    const p = await practice(t.db, { clerkOrgId: "org_known_no_member" });
    const token = await signSessionToken(keys, {
      sub: "user_not_a_member",
      claims: { o: { id: p.clerkOrgId, rol: "member" } },
    });
    const res = await getMeWithToken(token);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "forbidden",
      reason: "unknown_org",
    });
  });

  it("deactivated staff → 403 deactivated", async () => {
    const p = await practice(t.db);
    await staffMember(t.db, {
      practiceId: p.id,
      clerkUserId: "user_deactivated",
      deactivatedAt: new Date(),
    });
    const token = await signSessionToken(keys, {
      sub: "user_deactivated",
      claims: { o: { id: p.clerkOrgId, rol: "member" } },
    });
    const res = await getMeWithToken(token);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "forbidden",
      reason: "deactivated",
    });
  });

  it("happy path, v2 claims → fully-populated StaffActor", async () => {
    const p = await practice(t.db);
    const staff = await staffMember(t.db, {
      practiceId: p.id,
      clerkUserId: "user_happy_v2",
      role: "owner",
    });
    const token = await signSessionToken(keys, {
      sub: "user_happy_v2",
      claims: { o: { id: p.clerkOrgId, rol: "admin" } },
    });
    const res = await getMeWithToken(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      actor: {
        type: "staff",
        staffId: staff.id,
        practiceId: p.id,
        role: "owner",
        locationId: null,
      },
    });
  });

  it("happy path, v1 claims (org_id/org_role)", async () => {
    const p = await practice(t.db);
    const staff = await staffMember(t.db, {
      practiceId: p.id,
      clerkUserId: "user_happy_v1",
      role: "front_desk",
    });
    const token = await signSessionToken(keys, {
      sub: "user_happy_v1",
      // Real v1 tokens carry no `v` claim; drop the helper's default.
      claims: { v: undefined, org_id: p.clerkOrgId, org_role: "org:member" },
    });
    const res = await getMeWithToken(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actor: { staffId: string } };
    expect(body.actor.staffId).toBe(staff.id);
  });

  it("cookie-based auth (__session) works for dashboard SSR calls", async () => {
    const p = await practice(t.db);
    await staffMember(t.db, {
      practiceId: p.id,
      clerkUserId: "user_cookie",
    });
    const token = await signSessionToken(keys, {
      sub: "user_cookie",
      claims: { o: { id: p.clerkOrgId, rol: "member" } },
    });
    const res = await getMeWithToken(token, true);
    expect(res.status).toBe(200);
  });

  it("location-scoped staff → actor carries the location scope", async () => {
    const p = await practice(t.db);
    const loc = await location(t.db, { practiceId: p.id });
    await staffMember(t.db, {
      practiceId: p.id,
      clerkUserId: "user_scoped",
      locationId: loc.id,
    });
    const token = await signSessionToken(keys, {
      sub: "user_scoped",
      claims: { o: { id: p.clerkOrgId, rol: "member" } },
    });
    const res = await getMeWithToken(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actor: { locationId: string } };
    expect(body.actor.locationId).toBe(loc.id);
  });

  it("membership in practice A grants nothing under practice B's org claim", async () => {
    const practiceA = await practice(t.db);
    const practiceB = await practice(t.db);
    await staffMember(t.db, {
      practiceId: practiceA.id,
      clerkUserId: "user_a_only",
    });
    const token = await signSessionToken(keys, {
      sub: "user_a_only",
      claims: { o: { id: practiceB.clerkOrgId, rol: "member" } },
    });
    const res = await getMeWithToken(token);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "forbidden",
      reason: "unknown_org",
    });
  });
});
