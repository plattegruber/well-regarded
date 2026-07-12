/**
 * Google Business Profile OAuth connect flow (issue #118, Epic #7),
 * mounted under the staff-auth group at /api/integrations/google. Every
 * route is practice-scoped by construction (`staffAuth`) and gated by
 * `requirePermission("manage_settings")` (matrix: owner, office_manager,
 * multi_location_admin).
 *
 * The flow is ADR 0002 Appendix B verbatim:
 *
 * - GET /connect  — mints PKCE verifier + nonce, stores
 *   `{ verifier, practiceId, staffId }` in KV under the nonce (10-minute
 *   TTL, single-use), signs a state binding `{ practiceId, staffId, nonce,
 *   exp }`, and 302s the browser to Google's authorization endpoint with
 *   `scope=business.manage`, `access_type=offline`, `prompt=consent`
 *   (required to reliably get a refresh token), and the S256 challenge.
 * - GET /callback — verifies the state signature/expiry, checks the
 *   practice+staff binding against the authenticated actor (the CSRF
 *   defense), consumes the KV nonce (delete-on-read), exchanges the code
 *   with the PKCE verifier, encrypts `{ refreshToken, obtainedAt }` with
 *   the shared AES-GCM util, upserts `source_connections` (re-auth
 *   preserves `metadata`), audits, and redirects to the dashboard settings
 *   page. Flow failures redirect with `?error=<code>` instead of a bare
 *   4xx — the browser is mid-navigation, not calling an API.
 * - POST /disconnect — best-effort Google-side revocation, then
 *   `status='disconnected'` + credentials erased + audit, in one
 *   transaction.
 * - GET / — connection status JSON for the settings card (#121 builds the
 *   UI; this payload never includes credentials).
 *
 * Location discovery + mapping (issue #121) joins the group:
 *
 * - The callback runs discovery eagerly after a successful connect (ADR
 *   0002 Appendix B: "auto after connect") with the access token it
 *   already holds — best-effort, a Google hiccup never fails the connect.
 * - POST /locations/discover — the on-demand "Refresh locations" action:
 *   refreshes an access token, walks accounts × locations server-side in
 *   this one handler (multi-account pagination is several round trips —
 *   never waterfalled from the browser), and replaces
 *   `metadata.googleLocations` wholesale. Mappings are preserved.
 * - PUT /mappings — replaces `metadata.locationMappings` with the decided
 *   set via `saveGoogleLocationMappings` (shared with the dashboard
 *   action), which validates practice scope, snapshot membership, and the
 *   unverified-cannot-map rule, creates inline locations, and audits.
 *
 * All Google endpoint URLs come from env (`GOOGLE_OAUTH_*_URL`) so local
 * dev and tests point at the fake GBP server (#130).
 *
 * NEVER-LOG(credentials): refresh tokens, access tokens, PKCE verifiers,
 * and `encrypted_credentials` ciphertext must never appear in logs, audit
 * payloads, or responses from this module.
 */

import {
  type ApiEnv,
  apiEnvSchema,
  decryptField,
  encryptField,
  type GoogleConnectionCredentials,
  getEnv,
  keyringFromEnv,
  type StaffActor,
} from "@wellregarded/core";
import {
  audit,
  type Db,
  disconnectSourceConnection,
  getSourceConnection,
  markSourceConnectionNeedsReauth,
  patchSourceConnectionMetadata,
  type SourceConnection,
  saveGoogleLocationMappings,
  upsertSourceConnection,
} from "@wellregarded/db";
import {
  createGoogleAccessTokenProvider,
  discoverGoogleLocations,
  exchangeAuthorizationCode,
  GOOGLE_BUSINESS_MANAGE_SCOPE,
  type GoogleDataApiConfig,
  NeedsReauthError,
  revokeGoogleToken,
} from "@wellregarded/sources";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";

import type { AppEnv } from "../../bindings";
import {
  OAUTH_STATE_TTL_SECONDS,
  signOauthState,
  verifyOauthState,
} from "../../lib/oauthState";
import { requirePermission } from "../../middleware/staffAuth";

/** KV record stored under the nonce for the duration of one connect attempt. */
const kvRecordSchema = z.object({
  /** PKCE code verifier. NEVER-LOG(credentials). */
  verifier: z.string().min(1),
  practiceId: z.uuid(),
  staffId: z.uuid(),
});

function kvKey(nonce: string): string {
  return `google_oauth:${nonce}`;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** RFC 7636: 32 random bytes → 43-char base64url verifier. */
function generateCodeVerifier(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** RFC 7636 S256: base64url(SHA-256(ascii(code_verifier))). */
async function s256Challenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  return toBase64Url(new Uint8Array(digest));
}

function requireVar<K extends keyof ApiEnv>(
  env: ApiEnv,
  name: K,
): NonNullable<ApiEnv[K]> {
  const value = env[name];
  if (value === undefined || value === null || value === "") {
    // Misconfiguration, not an auth outcome — surfaces as a 500 via onError.
    throw new Error(
      `${String(name)} is not configured — the Google connect flow cannot ` +
        "run. See docs/secrets.md.",
    );
  }
  return value;
}

/**
 * The public URL of the /callback route: env override first, otherwise
 * derived from the incoming request (both /connect and /callback resolve to
 * the same value, which Google requires to match between the authorization
 * request and the code exchange).
 */
function callbackUrl(c: Context<AppEnv>, env: ApiEnv): string {
  if (env.GOOGLE_OAUTH_REDIRECT_URL) return env.GOOGLE_OAUTH_REDIRECT_URL;
  const url = new URL(c.req.url);
  const basePath = url.pathname.replace(/\/(connect|callback)$/, "");
  return `${url.origin}${basePath}/callback`;
}

/** Discovery client config — base URLs from env (fake GBP in local/tests). */
function dataApiConfig(env: ApiEnv, accessToken: string): GoogleDataApiConfig {
  return {
    accountManagementUrl: env.GOOGLE_ACCOUNT_MANAGEMENT_URL,
    businessInformationUrl: env.GOOGLE_BUSINESS_INFORMATION_URL,
    // NEVER-LOG(credentials).
    accessToken,
  };
}

/**
 * Run one discovery pass and replace the snapshot
 * (`metadata.googleLocations`) wholesale. Mappings and other metadata keys
 * (e.g. #123's sync cursors) are untouched — the patch is per-key.
 */
async function refreshLocationSnapshot(
  db: Db,
  env: ApiEnv,
  connectionId: string,
  accessToken: string,
): Promise<SourceConnection | null> {
  const googleLocations = await discoverGoogleLocations(
    dataApiConfig(env, accessToken),
  );
  return patchSourceConnectionMetadata(db, connectionId, { googleLocations });
}

/**
 * Redirect target on the dashboard: the integrations page (#121), which
 * renders the `?connected=` / `?error=` outcome banner.
 */
function settingsRedirect(env: ApiEnv, params: Record<string, string>): string {
  const url = new URL("/settings/integrations", env.DASHBOARD_ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Failure codes the callback hands back to the settings page. Stable API
 * surface for the #121 card — add, never rename.
 */
export type GoogleCallbackError =
  | "google_access_denied"
  | "google_invalid_callback"
  | "google_invalid_state"
  | "google_state_expired"
  | "google_state_mismatch"
  | "google_state_reused"
  | "google_exchange_failed"
  | "google_no_refresh_token";

/** What the status endpoint exposes — never `encrypted_credentials`. */
function connectionView(row: SourceConnection) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    scopes: row.scopes,
    connectedBy: row.connectedBy,
    lastSyncAt: row.lastSyncAt,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function staffAuditActor(actor: StaffActor): { type: "staff"; id: string } {
  return { type: "staff", id: actor.staffId };
}

export const googleIntegrationRoutes = new Hono<AppEnv>();

googleIntegrationRoutes.use("*", requirePermission("manage_settings"));

/** Connection status for the settings card. Credentials never leave the row. */
googleIntegrationRoutes.get("/", async (c) => {
  const actor = c.get("actor");
  const connection = await getSourceConnection(
    c.get("db"),
    actor.practiceId,
    "google",
  );
  return c.json({ connection: connection ? connectionView(connection) : null });
});

/**
 * Start the OAuth dance: 302 to Google's authorization endpoint. The
 * browser navigates here full-page (no popup) from the settings card.
 */
googleIntegrationRoutes.get("/connect", async (c) => {
  const env = getEnv(c.env, apiEnvSchema);
  const clientId = requireVar(env, "GOOGLE_CLIENT_ID");
  const stateSecret = requireVar(env, "GOOGLE_OAUTH_STATE_SECRET");
  const actor = c.get("actor");

  // NEVER-LOG(credentials): the verifier is a credential-equivalent — it
  // lives only in KV (single-use, 10-minute TTL), never in a cookie or log.
  const verifier = generateCodeVerifier();
  const nonce = crypto.randomUUID();
  await c.env.OAUTH_STATE.put(
    kvKey(nonce),
    JSON.stringify({
      verifier,
      practiceId: actor.practiceId,
      staffId: actor.staffId,
    }),
    { expirationTtl: OAUTH_STATE_TTL_SECONDS },
  );

  const state = await signOauthState(
    { practiceId: actor.practiceId, staffId: actor.staffId, nonce },
    stateSecret,
  );

  const authUrl = new URL(env.GOOGLE_OAUTH_AUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", callbackUrl(c, env));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_BUSINESS_MANAGE_SCOPE);
  // Both required to reliably receive a refresh token — Google omits it on
  // repeat consents otherwise (ADR 0002 §4).
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("code_challenge", await s256Challenge(verifier));
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  return c.redirect(authUrl.toString(), 302);
});

/** Google redirects the browser back here after consent. */
googleIntegrationRoutes.get("/callback", async (c) => {
  const env = getEnv(c.env, apiEnvSchema);
  const stateSecret = requireVar(env, "GOOGLE_OAUTH_STATE_SECRET");
  const actor = c.get("actor");
  const fail = (error: GoogleCallbackError) =>
    c.redirect(settingsRedirect(env, { error }), 302);

  // The user clicked "deny" (or Google reported another OAuth error).
  if (c.req.query("error")) return fail("google_access_denied");

  const stateParam = c.req.query("state");
  const code = c.req.query("code");
  if (!stateParam || !code) return fail("google_invalid_callback");

  const state = await verifyOauthState(stateParam, stateSecret);
  if (!state.ok) {
    return fail(
      state.reason === "expired"
        ? "google_state_expired"
        : "google_invalid_state",
    );
  }
  // The CSRF binding: the state must have been minted for THIS staff
  // session in THIS practice. Reject before touching KV or Google.
  if (
    state.payload.practiceId !== actor.practiceId ||
    state.payload.staffId !== actor.staffId
  ) {
    return fail("google_state_mismatch");
  }

  // Single-use: delete-on-read, so a replayed callback finds nothing.
  const kvRecordRaw = await c.env.OAUTH_STATE.get(kvKey(state.payload.nonce));
  if (kvRecordRaw !== null) {
    await c.env.OAUTH_STATE.delete(kvKey(state.payload.nonce));
  }
  let kvRecordJson: unknown = null;
  try {
    kvRecordJson = kvRecordRaw === null ? null : JSON.parse(kvRecordRaw);
  } catch {
    kvRecordJson = null;
  }
  const kvRecord = kvRecordSchema.safeParse(kvRecordJson);
  if (!kvRecord.success) return fail("google_state_reused");
  if (
    kvRecord.data.practiceId !== actor.practiceId ||
    kvRecord.data.staffId !== actor.staffId
  ) {
    return fail("google_state_mismatch");
  }

  let tokens: Awaited<ReturnType<typeof exchangeAuthorizationCode>>;
  try {
    tokens = await exchangeAuthorizationCode(
      {
        tokenUrl: env.GOOGLE_OAUTH_TOKEN_URL,
        clientId: requireVar(env, "GOOGLE_CLIENT_ID"),
        clientSecret: requireVar(env, "GOOGLE_CLIENT_SECRET"),
      },
      {
        code,
        codeVerifier: kvRecord.data.verifier,
        redirectUri: callbackUrl(c, env),
      },
    );
  } catch (error) {
    // NEVER-LOG(credentials): GoogleOAuthError messages carry status/code
    // only — safe to log; the code itself is not.
    c.get("logger").warn("google oauth code exchange failed", { error });
    return fail("google_exchange_failed");
  }

  // Google can omit the refresh token (repeat consent without the recipe,
  // or edge cases) — a connection without one cannot poll, so store
  // nothing and surface the error state (issue #118 requirement).
  if (!tokens.refreshToken) return fail("google_no_refresh_token");

  const keyring = keyringFromEnv({
    PII_ENCRYPTION_KEYS: requireVar(env, "PII_ENCRYPTION_KEYS"),
    PII_HASH_KEY: requireVar(env, "PII_HASH_KEY"),
  });
  const credentials: GoogleConnectionCredentials = {
    refreshToken: tokens.refreshToken,
    obtainedAt: new Date().toISOString(),
  };
  const encryptedCredentials = await encryptField(
    JSON.stringify(credentials),
    keyring,
  );
  const scopes = tokens.scope?.split(/\s+/).filter(Boolean) ?? [
    GOOGLE_BUSINESS_MANAGE_SCOPE,
  ];

  const connection = await c.get("db").transaction(async (tx) => {
    const existing = await getSourceConnection(tx, actor.practiceId, "google");
    const row = await upsertSourceConnection(tx, {
      practiceId: actor.practiceId,
      kind: "google",
      encryptedCredentials,
      scopes,
      connectedBy: actor.staffId,
    });
    await audit(tx, {
      practiceId: actor.practiceId,
      actor: staffAuditActor(actor),
      action: existing
        ? "source_connection.reauthorized"
        : "source_connection.connected",
      entityType: "source_connections",
      entityId: row.id,
      // References and non-sensitive fields only — never token material.
      payload: { kind: "google", scopes, previousStatus: existing?.status },
    });
    return row;
  });

  // Location discovery, eagerly, with the access token the exchange just
  // minted (issue #121; ADR 0002 Appendix B — "auto after connect").
  // Best-effort: a Google hiccup here must not fail the connect — the
  // mapping screen's "Refresh locations" action retries.
  try {
    await refreshLocationSnapshot(
      c.get("db"),
      env,
      connection.id,
      tokens.accessToken,
    );
  } catch (error) {
    c.get("logger").warn("google location discovery after connect failed", {
      error,
    });
  }

  return c.redirect(settingsRedirect(env, { connected: "google" }), 302);
});

/**
 * Disconnect: revoke at Google (best effort — our row is the source of
 * truth), then erase credentials and mark disconnected. Idempotent-ish:
 * an already-disconnected connection 404s like a missing one.
 */
googleIntegrationRoutes.post("/disconnect", async (c) => {
  const env = getEnv(c.env, apiEnvSchema);
  const actor = c.get("actor");
  const db = c.get("db");

  const existing = await getSourceConnection(db, actor.practiceId, "google");
  if (!existing || existing.status === "disconnected") {
    return c.json({ error: "not_found" as const }, 404);
  }

  // Best-effort revocation: decrypt the refresh token and tell Google to
  // drop the grant. Failure (or missing keyring) never blocks disconnect.
  let revoked = false;
  if (existing.encryptedCredentials) {
    try {
      const keyring = keyringFromEnv({
        PII_ENCRYPTION_KEYS: requireVar(env, "PII_ENCRYPTION_KEYS"),
        PII_HASH_KEY: requireVar(env, "PII_HASH_KEY"),
      });
      const credentials = JSON.parse(
        await decryptField(existing.encryptedCredentials, keyring),
      ) as GoogleConnectionCredentials;
      revoked = await revokeGoogleToken(
        { revokeUrl: env.GOOGLE_OAUTH_REVOKE_URL },
        credentials.refreshToken,
      );
    } catch (error) {
      // NEVER-LOG(credentials): error here may be a crypto failure —
      // log the event, never the material.
      c.get("logger").warn("google token revocation skipped", { error });
    }
  }

  const disconnected = await db.transaction(async (tx) => {
    const row = await disconnectSourceConnection(
      tx,
      actor.practiceId,
      "google",
    );
    if (!row) return null;
    await audit(tx, {
      practiceId: actor.practiceId,
      actor: staffAuditActor(actor),
      action: "source_connection.disconnected",
      entityType: "source_connections",
      entityId: row.id,
      payload: { kind: "google", revokedAtGoogle: revoked },
    });
    return row;
  });
  // Raced with another disconnect between the read and the update.
  if (!disconnected) return c.json({ error: "not_found" as const }, 404);

  return c.json({ connection: connectionView(disconnected) });
});

// ---------------------------------------------------------------------------
// Location discovery + mapping (issue #121)
// ---------------------------------------------------------------------------

/**
 * On-demand discovery ("Refresh locations"): refresh an access token from
 * the stored credentials, list every account's locations, and replace the
 * snapshot. Existing mappings are preserved (they live under a different
 * metadata key); locations that vanished from Google stay mapped but are
 * excluded from polling (`getActiveMappings`).
 */
googleIntegrationRoutes.post("/locations/discover", async (c) => {
  const env = getEnv(c.env, apiEnvSchema);
  const actor = c.get("actor");
  const db = c.get("db");

  const connection = await getSourceConnection(db, actor.practiceId, "google");
  if (!connection || connection.status === "disconnected") {
    return c.json({ error: "not_found" as const }, 404);
  }
  if (
    connection.status === "needs_reauth" ||
    !connection.encryptedCredentials
  ) {
    return c.json({ error: "needs_reauth" as const }, 409);
  }

  const keyring = keyringFromEnv({
    PII_ENCRYPTION_KEYS: requireVar(env, "PII_ENCRYPTION_KEYS"),
    PII_HASH_KEY: requireVar(env, "PII_HASH_KEY"),
  });
  const credentials = JSON.parse(
    await decryptField(connection.encryptedCredentials, keyring),
  ) as GoogleConnectionCredentials;

  // Per-request provider: no cross-request token cache to amortize here —
  // discovery is a rare, staff-initiated action (the poller, #123, owns
  // the long-lived provider). `onInvalidGrant` still makes a dead grant
  // durable before the 409.
  const provider = createGoogleAccessTokenProvider({
    config: {
      tokenUrl: env.GOOGLE_OAUTH_TOKEN_URL,
      clientId: requireVar(env, "GOOGLE_CLIENT_ID"),
      clientSecret: requireVar(env, "GOOGLE_CLIENT_SECRET"),
    },
    onInvalidGrant: async (connectionId) => {
      await markSourceConnectionNeedsReauth(db, connectionId);
    },
  });

  let updated: SourceConnection | null;
  try {
    const accessToken = await provider.getAccessToken({
      id: connection.id,
      refreshToken: credentials.refreshToken,
    });
    updated = await refreshLocationSnapshot(
      db,
      env,
      connection.id,
      accessToken,
    );
  } catch (error) {
    if (error instanceof NeedsReauthError) {
      return c.json({ error: "needs_reauth" as const }, 409);
    }
    // Transient Google-side failure (quota, 5xx, network): nothing was
    // persisted; the caller retries. NEVER-LOG(credentials): these error
    // messages carry status codes only.
    c.get("logger").warn("google location discovery failed", { error });
    return c.json({ error: "google_unavailable" as const }, 502);
  }
  if (!updated) return c.json({ error: "not_found" as const }, 404);

  return c.json({ connection: connectionView(updated) });
});

/** PUT /mappings request body — mirrors `GoogleMappingEntry` from @wellregarded/db. */
const putMappingsSchema = z.object({
  mappings: z.array(
    z.object({
      googleLocationName: z.string().min(1),
      decision: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("map"), locationId: z.uuid() }),
        z.object({ kind: z.literal("skip") }),
        z.object({
          kind: z.literal("create"),
          name: z.string().trim().min(1),
          addressLine1: z.string().nullish(),
          city: z.string().nullish(),
          state: z.string().nullish(),
          postalCode: z.string().nullish(),
        }),
      ]),
    }),
  ),
});

/**
 * Replace the mapping decisions wholesale. Validation (practice scope,
 * snapshot membership, unverified-cannot-map, duplicates) and auditing
 * live in `saveGoogleLocationMappings` — shared with the dashboard's
 * mapping-screen action so the rules cannot drift.
 */
googleIntegrationRoutes.put("/mappings", async (c) => {
  const body: unknown = await c.req.json().catch(() => undefined);
  const parsed = putMappingsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_body" as const }, 400);
  }
  const actor = c.get("actor");

  const result = await saveGoogleLocationMappings(c.get("db"), {
    practiceId: actor.practiceId,
    actor: staffAuditActor(actor),
    entries: parsed.data.mappings,
  });
  if (result.status === "not_found") {
    return c.json({ error: "not_found" as const }, 404);
  }
  if (result.status === "invalid") {
    return c.json(
      { error: "invalid_mappings" as const, issues: result.issues },
      422,
    );
  }
  return c.json({
    connection: connectionView(result.connection),
    mappings: result.mappings,
    createdLocations: result.createdLocations.map((location) => ({
      id: location.id,
      name: location.name,
    })),
  });
});

/**
 * Manual "Sync now" (issue #123 requirement 7, settings-card button):
 * invokes the SAME `SyncLock` DO entry point the cron uses, with trigger
 * `manual` — the per-connection lock naturally rejects it while a sync is
 * already in flight (mapped to 409 "already syncing" for the UI).
 *
 * The response waits for the sync: an incremental poll is a handful of
 * paced calls (seconds). A first-ever sync of a large multi-location
 * practice can take longer — acceptable at M1; if it ever isn't, the DO
 * can grow an alarm-based fire-and-forget start without changing this
 * contract.
 */
googleIntegrationRoutes.post("/sync", async (c) => {
  const actor = c.get("actor");
  const connection = await getSourceConnection(
    c.get("db"),
    actor.practiceId,
    "google",
  );
  if (!connection || connection.status === "disconnected") {
    return c.json({ error: "not_found" as const }, 404);
  }
  if (connection.status === "needs_reauth") {
    // Syncing a dead grant would just fail again — the card should show
    // the Reconnect prompt instead.
    return c.json({ error: "needs_reauth" as const }, 409);
  }

  const syncLock = c.env.SYNC_LOCK;
  if (syncLock === undefined) {
    // Misconfiguration (or a local dev session without the jobs worker):
    // actionable, not a silent no-op.
    return c.json(
      {
        error: "sync_unavailable" as const,
        detail:
          "SYNC_LOCK binding is missing — the jobs worker's Durable Object " +
          "namespace is not bound (local dev: run the jobs worker dev " +
          "session too; deployed: check wrangler.jsonc).",
      },
      503,
    );
  }

  const result = await syncLock
    .get(syncLock.idFromName(connection.id))
    .runSync({
      connectionId: connection.id,
      trigger: "manual",
      requestId: c.get("requestId"),
    });

  if (result.outcome === "already_running") {
    return c.json(
      {
        error: "already_syncing" as const,
        heldForMs: result.heldForMs,
      },
      409,
    );
  }
  if (result.outcome === "error") {
    // The DO already logged the details under this requestId.
    return c.json({ error: "sync_failed" as const }, 502);
  }
  return c.json({
    outcome: result.outcome,
    importRunId: result.importRunId,
    reason: result.reason,
    stats: result.stats,
  });
});
