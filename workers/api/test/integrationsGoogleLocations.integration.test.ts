/**
 * Location discovery + mapping integration tests (issue #121): the full
 * worker surface against real Postgres and the fake GBP server (#130),
 * seeded with the issue's testing matrix — 2 accounts / 4 locations
 * including 1 unverified.
 *
 * Covered: the callback's post-connect discovery persists the snapshot
 * (multi-account, flattened, verification state read); on-demand
 * re-discovery replaces the snapshot wholesale while preserving mappings;
 * PUT /mappings validates practice scope and unknown/unverified ids,
 * creates locations inline, audits; `getActiveMappings` excludes
 * unmapped/skipped/unverified; needs_reauth and disconnected states answer
 * 409/404.
 */

import { type ServerType, serve } from "@hono/node-server";
import {
  type GoogleDiscoveredLocation,
  type GoogleLocationMapping,
  resetEnvCache,
} from "@wellregarded/core";
import { schema } from "@wellregarded/db";
import { getActiveMappings } from "@wellregarded/sources";
import { createFakeGbp } from "@wellregarded/sources/google/fake";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  location,
  practice,
  staffMember,
  TEST_KEYRING_INPUT,
} from "../../../packages/db/test/factories.js";
import { setupTestDb } from "../../../packages/db/test/harness.js";
import {
  requireDatabaseUrl,
  withDatabase,
} from "../../../packages/db/test/support.js";
import { app } from "../src/app";
import { TEST_OAUTH_STATE_SECRET, type TestEnv, testEnv } from "./support/env";
import { FakeKv } from "./support/fakeKv";
import {
  generateTestKeys,
  signSessionToken,
  type TestKeys,
} from "./support/jwt";

const { auditLog, locations, sourceConnections } = schema;

const t = setupTestDb();

let server: ServerType;
let fakeBase: string;
let keys: TestKeys;
let kv: FakeKv;
// Fresh fake per test: discovery snapshots must not leak between tests.
let fake: ReturnType<typeof createFakeGbp>;

beforeAll(async () => {
  keys = await generateTestKeys();
});

afterAll(() => {
  server?.close();
});

beforeEach(async () => {
  resetEnvCache();
  kv = new FakeKv();
  server?.close();
  fake = createFakeGbp();
  await new Promise<void>((resolve) => {
    server = serve({ fetch: fake.app.fetch, port: 0 }, (info) => {
      fakeBase = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

function env(overrides: Partial<TestEnv> = {}): TestEnv {
  return testEnv({
    HYPERDRIVE: {
      connectionString: withDatabase(requireDatabaseUrl(), t.databaseName),
    },
    OAUTH_STATE: kv,
    CLERK_JWKS_PUBLIC_KEY: keys.publicKeyPem,
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    GOOGLE_OAUTH_STATE_SECRET: TEST_OAUTH_STATE_SECRET,
    GOOGLE_OAUTH_AUTH_URL: `${fakeBase}/o/oauth2/v2/auth`,
    GOOGLE_OAUTH_TOKEN_URL: `${fakeBase}/oauth/token`,
    GOOGLE_OAUTH_REVOKE_URL: `${fakeBase}/oauth/revoke`,
    GOOGLE_ACCOUNT_MANAGEMENT_URL: fakeBase,
    GOOGLE_BUSINESS_INFORMATION_URL: fakeBase,
    PII_ENCRYPTION_KEYS: JSON.stringify(TEST_KEYRING_INPUT.encryptionKeys),
    PII_HASH_KEY: TEST_KEYRING_INPUT.hashKey,
    ...overrides,
  });
}

/**
 * The issue's testing matrix: 2 accounts / 4 locations, 1 unverified.
 * Returns the fake's resource names for assertions.
 */
function seedFakeGoogle() {
  const agency = fake.store.addAccount({ accountName: "Smile Agency" });
  const client = fake.store.addLocation({
    account: agency.name,
    title: "Client Practice",
  });
  const own = fake.store.addAccount({
    accountName: "Cedar Ridge Dental Group",
  });
  const downtown = fake.store.addLocation({
    account: own.name,
    title: "Cedar Ridge Dental — Downtown",
    storefrontAddress: {
      regionCode: "US",
      postalCode: "49503",
      administrativeArea: "MI",
      locality: "Grand Rapids",
      addressLines: ["412 Cedar Ridge Ave", "Suite 200"],
    },
  });
  const westside = fake.store.addLocation({
    account: own.name,
    title: "Cedar Ridge Dental — Westside",
  });
  const unverified = fake.store.addLocation({
    account: own.name,
    title: "Cedar Ridge Dental — Old Listing",
    verified: false,
  });
  return { agency, own, client, downtown, westside, unverified };
}

async function ownerSession() {
  const p = await practice(t.db);
  const staff = await staffMember(t.db, {
    practiceId: p.id,
    clerkUserId: `user_gbp_loc_${p.slug}`,
    role: "owner",
  });
  const token = await signSessionToken(keys, {
    sub: staff.clerkUserId,
    claims: { o: { id: p.clerkOrgId, rol: "admin" } },
  });
  return { p, staff, token };
}

function authed(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  };
}

/** Full connect dance through the fake's auto-approving consent screen. */
async function connect(token: string): Promise<void> {
  const start = await app.request(
    "/api/integrations/google/connect",
    authed(token),
    env(),
  );
  expect(start.status).toBe(302);
  const consent = await fetch(start.headers.get("Location") ?? "", {
    redirect: "manual",
  });
  const back = new URL(consent.headers.get("Location") ?? "");
  const callback = await app.request(
    `${back.pathname}${back.search}`,
    authed(token),
    env(),
  );
  expect(callback.status).toBe(302);
  expect(callback.headers.get("Location")).toContain("connected=google");
}

async function connectionRow(practiceId: string) {
  const [row] = await t.db
    .select()
    .from(sourceConnections)
    .where(eq(sourceConnections.practiceId, practiceId));
  return row;
}

function snapshotOf(row: { metadata: unknown } | undefined) {
  return (
    ((row?.metadata as Record<string, unknown> | undefined)?.googleLocations as
      | GoogleDiscoveredLocation[]
      | undefined) ?? []
  );
}

function mappingsOf(row: { metadata: unknown } | undefined) {
  return (
    ((row?.metadata as Record<string, unknown> | undefined)?.locationMappings as
      | GoogleLocationMapping[]
      | undefined) ?? []
  );
}

async function putMappings(token: string, mappings: unknown) {
  return app.request(
    "/api/integrations/google/mappings",
    authed(token, { method: "PUT", body: JSON.stringify({ mappings }) }),
    env(),
  );
}

describe("post-connect discovery (integration)", () => {
  it("persists a multi-account snapshot with verification states", async () => {
    const seeded = seedFakeGoogle();
    const { p, token } = await ownerSession();
    await connect(token);

    const snapshot = snapshotOf(await connectionRow(p.id));
    expect(snapshot).toHaveLength(4);
    expect(
      snapshot.map((l) => [
        l.googleLocationName,
        l.accountDisplayName,
        l.verificationState,
      ]),
    ).toEqual([
      [seeded.client.name, "Smile Agency", "verified"],
      [seeded.downtown.name, "Cedar Ridge Dental Group", "verified"],
      [seeded.westside.name, "Cedar Ridge Dental Group", "verified"],
      [seeded.unverified.name, "Cedar Ridge Dental Group", "unverified"],
    ]);
    const downtown = snapshot.find(
      (l) => l.googleLocationName === seeded.downtown.name,
    );
    expect(downtown?.googleAccountName).toBe(seeded.own.name);
    expect(downtown?.address).toBe(
      "412 Cedar Ridge Ave, Suite 200, Grand Rapids, MI 49503",
    );
  });
});

describe("POST /integrations/google/locations/discover (integration)", () => {
  it("refreshes the snapshot wholesale and preserves existing mappings", async () => {
    const seeded = seedFakeGoogle();
    const { p, token } = await ownerSession();
    await connect(token);
    const ours = await location(t.db, { practiceId: p.id });

    const saved = await putMappings(token, [
      {
        googleLocationName: seeded.downtown.name,
        decision: { kind: "map", locationId: ours.id },
      },
    ]);
    expect(saved.status).toBe(200);

    // Google-side change between discoveries: one new location appears.
    const added = fake.store.addLocation({
      account: seeded.own.name,
      title: "Cedar Ridge Dental — North Park",
    });

    const res = await app.request(
      "/api/integrations/google/locations/discover",
      authed(token, { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(200);

    const row = await connectionRow(p.id);
    const snapshot = snapshotOf(row);
    expect(snapshot).toHaveLength(5);
    expect(snapshot.some((l) => l.googleLocationName === added.name)).toBe(
      true,
    );
    // Re-discovery preserved the mapping for the still-present location.
    expect(mappingsOf(row)).toEqual([
      expect.objectContaining({
        googleLocationName: seeded.downtown.name,
        locationId: ours.id,
      }),
    ]);
  });

  it("409s (needs_reauth) when the refresh grant is dead, durably", async () => {
    seedFakeGoogle();
    const { p, token } = await ownerSession();
    await connect(token);

    // Google rejects the next refresh (user revocation / 7-day Testing
    // expiry — ADR 0002 §4): invalid_grant.
    fake.store.failNext("POST /oauth/token", {
      status: 400,
      body: { error: "invalid_grant" },
    });
    const rejected = await app.request(
      "/api/integrations/google/locations/discover",
      authed(token, { method: "POST" }),
      env(),
    );
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: "needs_reauth" });
    expect((await connectionRow(p.id))?.status).toBe("needs_reauth");
  });

  it("404s with no connection; 502s on a transient Google failure (nothing persisted)", async () => {
    seedFakeGoogle();
    const { p, token } = await ownerSession();

    const missing = await app.request(
      "/api/integrations/google/locations/discover",
      authed(token, { method: "POST" }),
      env(),
    );
    expect(missing.status).toBe(404);

    await connect(token);
    const before = snapshotOf(await connectionRow(p.id));

    fake.store.failNext("GET /v1/accounts", { status: 503 });
    const res = await app.request(
      "/api/integrations/google/locations/discover",
      authed(token, { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "google_unavailable" });
    expect(snapshotOf(await connectionRow(p.id))).toEqual(before);
  });
});

describe("PUT /integrations/google/mappings (integration)", () => {
  it("maps, skips, creates inline — and getActiveMappings sees only mapped+verified", async () => {
    const seeded = seedFakeGoogle();
    const { p, token } = await ownerSession();
    await connect(token);
    const ours = await location(t.db, {
      practiceId: p.id,
      name: "Downtown",
    });

    const res = await putMappings(token, [
      {
        googleLocationName: seeded.downtown.name,
        decision: { kind: "map", locationId: ours.id },
      },
      { googleLocationName: seeded.westside.name, decision: { kind: "skip" } },
      {
        googleLocationName: seeded.client.name,
        decision: {
          kind: "create",
          name: "Client Practice",
          addressLine1: "1 Client Way",
          city: "Grand Rapids",
          state: "MI",
        },
      },
      // The unverified listing is deliberately absent: undecided.
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connection: { metadata: Record<string, unknown> };
      mappings: GoogleLocationMapping[];
      createdLocations: Array<{ id: string; name: string }>;
    };
    expect(body.createdLocations).toEqual([
      { id: expect.any(String), name: "Client Practice" },
    ]);
    expect(JSON.stringify(body)).not.toContain("refresh");

    // The created row exists, practice-scoped.
    const [created] = await t.db
      .select()
      .from(locations)
      .where(eq(locations.id, body.createdLocations[0]?.id ?? ""));
    expect(created?.practiceId).toBe(p.id);
    expect(created?.addressLine1).toBe("1 Client Way");

    // The poller contract: only mapped, verified locations are active, and
    // the active entries carry the account-scoped v4 name.
    const row = await connectionRow(p.id);
    if (!row) throw new Error("expected a connection");
    const { active, excluded } = getActiveMappings(row);
    // Active entries follow snapshot order (agency account listed first).
    expect(active).toEqual([
      {
        googleLocationName: seeded.client.name,
        googleAccountName: seeded.agency.name,
        v4LocationName: `${seeded.agency.name}/${seeded.client.name}`,
        locationId: body.createdLocations[0]?.id,
      },
      {
        googleLocationName: seeded.downtown.name,
        googleAccountName: seeded.own.name,
        v4LocationName: `${seeded.own.name}/${seeded.downtown.name}`,
        locationId: ours.id,
      },
    ]);
    expect(excluded).toEqual(
      expect.arrayContaining([
        { googleLocationName: seeded.westside.name, reason: "skipped" },
        { googleLocationName: seeded.unverified.name, reason: "unverified" },
      ]),
    );

    // Audit trail: connect, inline creation, mapping change.
    const actions = (
      await t.db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.practiceId, p.id))
        .orderBy(auditLog.createdAt)
    ).map((r) => r.action);
    expect(actions).toEqual([
      "source_connection.connected",
      "location.created",
      "source_connection.mappings_updated",
    ]);
  });

  it("422s on unknown snapshot names, cross-practice locations, and unverified maps", async () => {
    const seeded = seedFakeGoogle();
    const { token } = await ownerSession();
    await connect(token);

    const otherPractice = await practice(t.db);
    const foreign = await location(t.db, { practiceId: otherPractice.id });

    const unknown = await putMappings(token, [
      { googleLocationName: "locations/999", decision: { kind: "skip" } },
    ]);
    expect(unknown.status).toBe(422);
    expect(
      ((await unknown.json()) as { issues: Array<{ code: string }> }).issues,
    ).toEqual([expect.objectContaining({ code: "unknown_google_location" })]);

    const crossPractice = await putMappings(token, [
      {
        googleLocationName: seeded.downtown.name,
        decision: { kind: "map", locationId: foreign.id },
      },
    ]);
    expect(crossPractice.status).toBe(422);
    expect(
      ((await crossPractice.json()) as { issues: Array<{ code: string }> })
        .issues,
    ).toEqual([expect.objectContaining({ code: "unknown_location" })]);

    const unverifiedMap = await putMappings(token, [
      {
        googleLocationName: seeded.unverified.name,
        decision: {
          kind: "create",
          name: "Old Listing",
        },
      },
    ]);
    expect(unverifiedMap.status).toBe(422);
    expect(
      ((await unverifiedMap.json()) as { issues: Array<{ code: string }> })
        .issues,
    ).toEqual([
      expect.objectContaining({ code: "unverified_google_location" }),
    ]);
  });

  it("404s without a google connection", async () => {
    const { token } = await ownerSession();
    const res = await putMappings(token, []);
    expect(res.status).toBe(404);
  });
});
