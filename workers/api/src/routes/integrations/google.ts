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
  disconnectSourceConnection,
  getSourceConnection,
  type SourceConnection,
  upsertSourceConnection,
} from "@wellregarded/db";
import {
  exchangeAuthorizationCode,
  GOOGLE_BUSINESS_MANAGE_SCOPE,
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

/** Redirect target on the dashboard settings page. */
function settingsRedirect(env: ApiEnv, params: Record<string, string>): string {
  const url = new URL("/settings", env.DASHBOARD_ORIGIN);
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

  await c.get("db").transaction(async (tx) => {
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
  });

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
