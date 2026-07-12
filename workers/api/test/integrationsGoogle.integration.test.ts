/**
 * Google connect-flow integration tests (issue #118): the full cycle
 * against real Postgres (packages/db's template-clone harness) and the
 * fake GBP server (#130) served over localhost by @hono/node-server on an
 * ephemeral port — the app under test talks to it through the
 * GOOGLE_OAUTH_*_URL env vars exactly as a deployed worker would talk to
 * Google. No real Google call anywhere.
 *
 * Covered: connect → Google consent (auto-approving fake) → callback →
 * encrypted row that decrypts back; nonce single-use; PKCE enforcement;
 * missing-refresh-token error state; refresh → invalid_grant →
 * needs_reauth persisted + NeedsReauthError; disconnect (revocation +
 * credential erasure); re-auth preserving metadata; audit entries for all
 * three actions.
 */

import { type ServerType, serve } from "@hono/node-server";
import {
  decryptField,
  type GoogleConnectionCredentials,
  resetEnvCache,
} from "@wellregarded/core";
import { markSourceConnectionNeedsReauth, schema } from "@wellregarded/db";
import {
  createGoogleAccessTokenProvider,
  NeedsReauthError,
} from "@wellregarded/sources";
import { createFakeGbp } from "@wellregarded/sources/google/fake";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  practice,
  staffMember,
  TEST_KEYRING,
  TEST_KEYRING_INPUT,
} from "../../../packages/db/test/factories.js";
import { setupTestDb } from "../../../packages/db/test/harness.js";
import {
  requireDatabaseUrl,
  withDatabase,
} from "../../../packages/db/test/support.js";
import { app } from "../src/app";
import { signOauthState } from "../src/lib/oauthState";
import { TEST_OAUTH_STATE_SECRET, type TestEnv, testEnv } from "./support/env";
import { FakeKv } from "./support/fakeKv";
import {
  generateTestKeys,
  signSessionToken,
  type TestKeys,
} from "./support/jwt";

const { auditLog, sourceConnections } = schema;

// The worker env and the test's decrypt assertions share one keyring —
// TEST_KEYRING(_INPUT) from the db factories, fed through the env vars.
const TEST_PII_ENCRYPTION_KEYS = JSON.stringify(
  TEST_KEYRING_INPUT.encryptionKeys,
);
const TEST_PII_HASH_KEY = TEST_KEYRING_INPUT.hashKey;

const t = setupTestDb();
const fake = createFakeGbp();

let server: ServerType;
let fakeBase: string;
let keys: TestKeys;
// One KV shared across requests within a test (connect writes, callback reads).
let kv: FakeKv;

beforeAll(async () => {
  keys = await generateTestKeys();
  await new Promise<void>((resolve) => {
    server = serve({ fetch: fake.app.fetch, port: 0 }, (info) => {
      fakeBase = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  resetEnvCache();
  kv = new FakeKv();
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
    // The callback's post-connect discovery (#121) must hit the fake too —
    // the schema defaults are the real Google hosts.
    GOOGLE_ACCOUNT_MANAGEMENT_URL: fakeBase,
    GOOGLE_BUSINESS_INFORMATION_URL: fakeBase,
    PII_ENCRYPTION_KEYS: TEST_PII_ENCRYPTION_KEYS,
    PII_HASH_KEY: TEST_PII_HASH_KEY,
    ...overrides,
  });
}

/** A practice with an owner whose JWT the app accepts. */
async function ownerSession() {
  const p = await practice(t.db);
  const staff = await staffMember(t.db, {
    practiceId: p.id,
    clerkUserId: `user_gbp_${p.slug}`,
    role: "owner",
  });
  const token = await signSessionToken(keys, {
    sub: staff.clerkUserId,
    claims: { o: { id: p.clerkOrgId, rol: "admin" } },
  });
  return { p, staff, token };
}

function authed(token: string): RequestInit {
  return { headers: { Authorization: `Bearer ${token}` } };
}

/**
 * Drive the browser's part of the dance: hit /connect on the app, follow
 * the 302 to the fake Google over real HTTP (redirect: manual), and return
 * the callback path+query Google sends the browser back to.
 */
async function browseConnectFlow(token: string): Promise<string> {
  const connect = await app.request(
    "/api/integrations/google/connect",
    authed(token),
    env(),
  );
  expect(connect.status).toBe(302);
  const authUrl = connect.headers.get("Location") ?? "";
  expect(authUrl.startsWith(fakeBase)).toBe(true);

  const consent = await fetch(authUrl, { redirect: "manual" });
  expect(consent.status).toBe(302);
  const back = new URL(consent.headers.get("Location") ?? "");
  return `${back.pathname}${back.search}`;
}

async function connectionRow(practiceId: string) {
  const [row] = await t.db
    .select()
    .from(sourceConnections)
    .where(eq(sourceConnections.practiceId, practiceId));
  return row;
}

async function auditActions(practiceId: string): Promise<string[]> {
  const rows = await t.db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(eq(auditLog.practiceId, practiceId))
    .orderBy(auditLog.createdAt);
  return rows.map((r) => r.action);
}

describe("connect → callback (integration)", () => {
  it("stores an active connection whose credentials decrypt back; audits; single-use nonce", async () => {
    const { p, staff, token } = await ownerSession();
    const callbackPath = await browseConnectFlow(token);

    const callback = await app.request(callbackPath, authed(token), env());
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe(
      "http://localhost:5173/settings/integrations?connected=google",
    );

    const row = await connectionRow(p.id);
    if (!row) throw new Error("expected a source_connections row");
    expect(row.kind).toBe("google");
    expect(row.status).toBe("active");
    expect(row.connectedBy).toBe(staff.id);
    expect(row.scopes).toEqual([
      "https://www.googleapis.com/auth/business.manage",
    ]);

    // NEVER-LOG(credentials) — but tests may decrypt to prove custody.
    if (!row.encryptedCredentials) throw new Error("expected ciphertext");
    expect(row.encryptedCredentials).toMatch(/^v1:/); // AES-GCM util format
    const credentials = JSON.parse(
      await decryptField(row.encryptedCredentials, TEST_KEYRING),
    ) as GoogleConnectionCredentials;
    expect(credentials.refreshToken).toMatch(/^fake-refresh-token-/);
    expect(fake.store.isValidRefreshToken(credentials.refreshToken)).toBe(true);
    expect(Date.parse(credentials.obtainedAt)).not.toBeNaN();

    expect(await auditActions(p.id)).toEqual(["source_connection.connected"]);

    // The nonce was consumed on read: replaying the same callback is
    // rejected and writes nothing new.
    const replay = await app.request(callbackPath, authed(token), env());
    expect(replay.status).toBe(302);
    expect(
      new URL(replay.headers.get("Location") ?? "").searchParams.get("error"),
    ).toBe("google_state_reused");
    expect(await auditActions(p.id)).toHaveLength(1);
  });

  it("status endpoint reflects the connection and never leaks credentials", async () => {
    const { p, token } = await ownerSession();

    const before = await app.request(
      "/api/integrations/google",
      authed(token),
      env(),
    );
    expect(await before.json()).toEqual({ connection: null });

    const callbackPath = await browseConnectFlow(token);
    await app.request(callbackPath, authed(token), env());

    const after = await app.request(
      "/api/integrations/google",
      authed(token),
      env(),
    );
    const body = (await after.json()) as {
      connection: Record<string, unknown>;
    };
    expect(body.connection.status).toBe("active");
    expect(body.connection.kind).toBe("google");
    expect(JSON.stringify(body)).not.toContain("Credentials");
    expect(JSON.stringify(body)).not.toContain("refresh");
    const row = await connectionRow(p.id);
    expect(JSON.stringify(body)).not.toContain(
      row?.encryptedCredentials ?? "!",
    );
  });

  it("a tampered PKCE verifier makes the exchange fail — nothing stored", async () => {
    const { p, token } = await ownerSession();
    const callbackPath = await browseConnectFlow(token);

    // Corrupt the stored verifier between consent and callback: the fake's
    // token endpoint (which verifies S256) must reject the exchange.
    const key = kv.onlyKey();
    const record = JSON.parse((await kv.get(key)) ?? "") as {
      verifier: string;
    };
    await kv.put(key, JSON.stringify({ ...record, verifier: "A".repeat(43) }));

    const callback = await app.request(callbackPath, authed(token), env());
    expect(
      new URL(callback.headers.get("Location") ?? "").searchParams.get("error"),
    ).toBe("google_exchange_failed");
    expect(await connectionRow(p.id)).toBeUndefined();
    expect(await auditActions(p.id)).toEqual([]);
  });

  it("no refresh token from Google → error state, nothing stored", async () => {
    const { p, staff, token } = await ownerSession();

    // Seed the state + KV by hand and mint a code the fake will answer
    // WITHOUT a refresh token (Google's repeat-consent behavior).
    const nonce = crypto.randomUUID();
    await kv.put(
      `google_oauth:${nonce}`,
      JSON.stringify({
        verifier: "A".repeat(43),
        practiceId: p.id,
        staffId: staff.id,
      }),
    );
    const state = await signOauthState(
      { practiceId: p.id, staffId: staff.id, nonce },
      TEST_OAUTH_STATE_SECRET,
    );
    const code = fake.store.issueAuthCode({ withRefreshToken: false });

    const callback = await app.request(
      `/api/integrations/google/callback?${new URLSearchParams({ code, state })}`,
      authed(token),
      env(),
    );
    expect(
      new URL(callback.headers.get("Location") ?? "").searchParams.get("error"),
    ).toBe("google_no_refresh_token");
    expect(await connectionRow(p.id)).toBeUndefined();
  });
});

describe("token refresh lifecycle (integration)", () => {
  it("refreshes against the fake, then invalid_grant → needs_reauth persisted + NeedsReauthError", async () => {
    const { p, token } = await ownerSession();
    await app.request(await browseConnectFlow(token), authed(token), env());
    const row = await connectionRow(p.id);
    if (!row?.encryptedCredentials) throw new Error("expected a connection");
    const { refreshToken } = JSON.parse(
      await decryptField(row.encryptedCredentials, TEST_KEYRING),
    ) as GoogleConnectionCredentials;

    const provider = createGoogleAccessTokenProvider({
      config: {
        tokenUrl: `${fakeBase}/oauth/token`,
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
      },
      // The wiring under test: invalid_grant durably marks the row.
      onInvalidGrant: async (connectionId) => {
        await markSourceConnectionNeedsReauth(t.db, connectionId);
      },
    });

    // Happy path: the minted access token works against the fake's data API.
    const accessToken = await provider.getAccessToken({
      id: row.id,
      refreshToken,
    });
    fake.store.addAccount();
    const accounts = await fetch(`${fakeBase}/v1/accounts`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(accounts.status).toBe(200);

    // Google revokes the grant (user revocation / 7-day Testing expiry) —
    // the next refresh sees invalid_grant.
    fake.store.revokeRefreshToken(refreshToken);
    provider.invalidate(row.id);
    await expect(
      provider.getAccessToken({ id: row.id, refreshToken }),
    ).rejects.toBeInstanceOf(NeedsReauthError);

    const after = await connectionRow(p.id);
    expect(after?.status).toBe("needs_reauth");
    // Credentials stay in place — re-auth overwrites them; only disconnect
    // erases.
    expect(after?.encryptedCredentials).not.toBeNull();
  });

  it("re-auth after needs_reauth: new credentials, active again, metadata preserved, audited", async () => {
    const { p, token } = await ownerSession();
    await app.request(await browseConnectFlow(token), authed(token), env());
    const first = await connectionRow(p.id);
    if (!first?.encryptedCredentials) throw new Error("expected a connection");

    // #121's location mapping lands in metadata; the poller then hits
    // invalid_grant. Both precede the re-auth.
    const metadata = {
      mappings: [{ locationId: "loc-1", google: "locations/1" }],
    };
    await t.db
      .update(sourceConnections)
      .set({ metadata, status: "needs_reauth" })
      .where(eq(sourceConnections.id, first.id));

    const callbackPath = await browseConnectFlow(token);
    const callback = await app.request(callbackPath, authed(token), env());
    expect(callback.headers.get("Location")).toContain("connected=google");

    const second = await connectionRow(p.id);
    if (!second?.encryptedCredentials) throw new Error("expected a connection");
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("active");
    // The #121 keys survive; the callback's post-connect discovery may add
    // a fresh `googleLocations` snapshot alongside them.
    expect(second.metadata).toMatchObject(metadata);
    expect(second.encryptedCredentials).not.toBe(first.encryptedCredentials);
    const credentials = JSON.parse(
      await decryptField(second.encryptedCredentials, TEST_KEYRING),
    ) as GoogleConnectionCredentials;
    expect(fake.store.isValidRefreshToken(credentials.refreshToken)).toBe(true);

    expect(await auditActions(p.id)).toEqual([
      "source_connection.connected",
      "source_connection.reauthorized",
    ]);
  });
});

describe("disconnect (integration)", () => {
  it("revokes at Google (best effort), erases credentials, audits; 404 when nothing to disconnect", async () => {
    const { p, token } = await ownerSession();

    // Nothing connected yet → 404.
    const early = await app.request(
      "/api/integrations/google/disconnect",
      { method: "POST", ...authed(token) },
      env(),
    );
    expect(early.status).toBe(404);

    await app.request(await browseConnectFlow(token), authed(token), env());
    const row = await connectionRow(p.id);
    if (!row?.encryptedCredentials) throw new Error("expected a connection");
    const { refreshToken } = JSON.parse(
      await decryptField(row.encryptedCredentials, TEST_KEYRING),
    ) as GoogleConnectionCredentials;

    const res = await app.request(
      "/api/integrations/google/disconnect",
      { method: "POST", ...authed(token) },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connection: { status: string } };
    expect(body.connection.status).toBe("disconnected");

    const after = await connectionRow(p.id);
    expect(after?.status).toBe("disconnected");
    expect(after?.encryptedCredentials).toBeNull(); // dead tokens never kept
    // Google-side grant is gone too (best-effort revocation reached the fake).
    expect(fake.store.isValidRefreshToken(refreshToken)).toBe(false);

    expect(await auditActions(p.id)).toEqual([
      "source_connection.connected",
      "source_connection.disconnected",
    ]);

    // Idempotence: a second disconnect finds nothing to transition.
    const again = await app.request(
      "/api/integrations/google/disconnect",
      { method: "POST", ...authed(token) },
      env(),
    );
    expect(again.status).toBe(404);
  });

  it("reconnect after disconnect restores active in place, audited as re-auth", async () => {
    const { p, token } = await ownerSession();
    await app.request(await browseConnectFlow(token), authed(token), env());
    await app.request(
      "/api/integrations/google/disconnect",
      { method: "POST", ...authed(token) },
      env(),
    );

    await app.request(await browseConnectFlow(token), authed(token), env());
    const row = await connectionRow(p.id);
    expect(row?.status).toBe("active");
    expect(row?.encryptedCredentials).not.toBeNull();
    expect(await auditActions(p.id)).toEqual([
      "source_connection.connected",
      "source_connection.disconnected",
      "source_connection.reauthorized",
    ]);
  });
});
