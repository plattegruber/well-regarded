/**
 * Google OAuth client helpers (issue #118, Epic #7): authorization-code
 * exchange, the access-token provider with refresh, and best-effort
 * revocation.
 *
 * Worker-runtime clean — WebCrypto + fetch only, no Hono, no node imports —
 * and everything is injectable: the token/revoke URLs come from env
 * (`GOOGLE_OAUTH_TOKEN_URL` / `GOOGLE_OAUTH_REVOKE_URL` — local dev and
 * tests point them at the fake GBP server, #130) and `fetch` can be
 * replaced in-process (`fakeGbp.app.fetch`).
 *
 * Refresh-token durability (ADR 0002 §4): while the OAuth consent screen is
 * in Testing publishing status refresh tokens die after 7 days; published
 * tokens die on user revocation, 6 months unused, or the 100-token
 * per-account-per-client cap. All of these surface as `invalid_grant` on
 * refresh — expected operational events, handled by marking the connection
 * `needs_reauth` (via `onInvalidGrant`) and throwing `NeedsReauthError`,
 * never by retrying.
 *
 * NEVER-LOG(credentials): tokens flowing through this module must never
 * appear in logs or error messages.
 */

/** The only Business Profile scope Google offers (ADR 0002 §4). */
export const GOOGLE_BUSINESS_MANAGE_SCOPE =
  "https://www.googleapis.com/auth/business.manage";

/**
 * Treat an access token expiring within this window as already expired —
 * a token that dies mid-request is worse than an early refresh.
 */
export const ACCESS_TOKEN_SKEW_MS = 60_000;

/** The connection's refresh grant is dead; re-run the connect flow. */
export class NeedsReauthError extends Error {
  readonly connectionId: string;

  constructor(connectionId: string) {
    super(
      `Google refresh token rejected (invalid_grant) for source connection ` +
        `${connectionId} — the connection needs re-authorization.`,
    );
    this.name = "NeedsReauthError";
    this.connectionId = connectionId;
  }
}

/** A non-`invalid_grant` failure talking to the token endpoint. */
export class GoogleOAuthError extends Error {
  readonly status: number;
  /** OAuth `error` code when the response carried one (e.g. `invalid_client`). */
  readonly code: string | undefined;

  constructor(what: string, status: number, code?: string) {
    // NEVER-LOG(credentials): message carries status/code only, no tokens.
    super(
      `Google OAuth ${what} failed with status ${status}` +
        (code ? ` (${code})` : ""),
    );
    this.name = "GoogleOAuthError";
    this.status = status;
    this.code = code;
  }
}

export interface GoogleOAuthConfig {
  /** Full token endpoint URL (real: `https://oauth2.googleapis.com/token`). */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Injectable for tests (`fakeGbp.app.fetch`-backed). Default: global fetch. */
  fetch?: typeof fetch;
}

interface TokenEndpointBody {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postTokenEndpoint(
  config: GoogleOAuthConfig,
  what: string,
  params: Record<string, string>,
): Promise<TokenEndpointBody> {
  const doFetch = config.fetch ?? fetch;
  const response = await doFetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await response.json().catch(() => ({}))) as TokenEndpointBody;
  if (!response.ok) {
    throw new GoogleOAuthError(
      what,
      response.status,
      typeof body.error === "string" ? body.error : undefined,
    );
  }
  return body;
}

export interface ExchangedTokens {
  accessToken: string;
  /** Absent when Google withheld it (repeat consent without `prompt=consent`). */
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
}

/**
 * Exchange an authorization code (with its PKCE verifier) for tokens.
 * Callers must handle the missing-`refreshToken` case explicitly — store
 * nothing and surface an error state (issue #118 requirement); this
 * function reports what Google returned.
 */
export async function exchangeAuthorizationCode(
  config: GoogleOAuthConfig,
  input: { code: string; codeVerifier: string; redirectUri: string },
): Promise<ExchangedTokens> {
  const body = await postTokenEndpoint(config, "code exchange", {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  if (!body.access_token || typeof body.expires_in !== "number") {
    throw new GoogleOAuthError("code exchange", 200, "malformed_response");
  }
  const tokens: ExchangedTokens = {
    accessToken: body.access_token,
    expiresIn: body.expires_in,
  };
  if (body.refresh_token) tokens.refreshToken = body.refresh_token;
  if (body.scope) tokens.scope = body.scope;
  return tokens;
}

/** What `getAccessToken` needs to know about a connection. */
export interface RefreshableConnection {
  /** `source_connections.id` — the cache key and `NeedsReauthError` subject. */
  id: string;
  /** Decrypted refresh token. NEVER-LOG(credentials). */
  refreshToken: string;
}

export interface AccessTokenProviderOptions {
  config: GoogleOAuthConfig;
  /**
   * Persistence hook fired exactly once per `invalid_grant` refresh
   * rejection, BEFORE `NeedsReauthError` is thrown — wire it to
   * `markSourceConnectionNeedsReauth` so the status change is durable even
   * when callers mishandle the error.
   */
  onInvalidGrant?: (connectionId: string) => Promise<void>;
  /** Injectable clock (ms since epoch) for expiry tests. Default: Date.now. */
  now?: () => number;
  /** Expiry slack. Default {@link ACCESS_TOKEN_SKEW_MS}. */
  skewMs?: number;
}

export interface AccessTokenProvider {
  /**
   * A valid access token for the connection: cached while fresh (expiry
   * minus skew), refreshed otherwise. Concurrent calls for one connection
   * single-flight into a single refresh HTTP request. Throws
   * `NeedsReauthError` on `invalid_grant` (after `onInvalidGrant` ran) and
   * `GoogleOAuthError` on any other token-endpoint failure (transient —
   * retryable by the caller, never a reason to mark `needs_reauth`).
   */
  getAccessToken(connection: RefreshableConnection): Promise<string>;
  /** Drop a connection's cache entry (e.g. after a 401 from a data call). */
  invalidate(connectionId: string): void;
}

interface CacheEntry {
  /** The refresh token the entry was minted from — re-auth invalidates it. */
  refreshToken: string;
  accessToken: string;
  expiresAtMs: number;
}

/**
 * Build a per-isolate token provider. Construct once at module/isolate
 * scope in workers so the cache actually amortizes; tests construct one per
 * scenario.
 */
export function createGoogleAccessTokenProvider(
  options: AccessTokenProviderOptions,
): AccessTokenProvider {
  const now = options.now ?? Date.now;
  const skewMs = options.skewMs ?? ACCESS_TOKEN_SKEW_MS;
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<string>>();

  async function refresh(connection: RefreshableConnection): Promise<string> {
    let body: TokenEndpointBody;
    try {
      body = await postTokenEndpoint(options.config, "token refresh", {
        grant_type: "refresh_token",
        refresh_token: connection.refreshToken,
        client_id: options.config.clientId,
        client_secret: options.config.clientSecret,
      });
    } catch (error) {
      if (error instanceof GoogleOAuthError && error.code === "invalid_grant") {
        cache.delete(connection.id);
        await options.onInvalidGrant?.(connection.id);
        throw new NeedsReauthError(connection.id);
      }
      throw error;
    }
    if (!body.access_token || typeof body.expires_in !== "number") {
      throw new GoogleOAuthError("token refresh", 200, "malformed_response");
    }
    cache.set(connection.id, {
      refreshToken: connection.refreshToken,
      accessToken: body.access_token,
      expiresAtMs: now() + body.expires_in * 1000,
    });
    return body.access_token;
  }

  return {
    async getAccessToken(connection) {
      const cached = cache.get(connection.id);
      if (
        cached &&
        cached.refreshToken === connection.refreshToken &&
        cached.expiresAtMs - skewMs > now()
      ) {
        return cached.accessToken;
      }
      const pending = inflight.get(connection.id);
      if (pending) return pending;
      const flight = refresh(connection).finally(() => {
        inflight.delete(connection.id);
      });
      inflight.set(connection.id, flight);
      return flight;
    },
    invalidate(connectionId) {
      cache.delete(connectionId);
    },
  };
}

/**
 * Best-effort token revocation (disconnect path): tells Google to drop the
 * refresh grant. Returns whether Google acknowledged; NEVER throws — a
 * failed revocation must not block the disconnect, whose source of truth
 * is our own row (status + erased ciphertext).
 */
export async function revokeGoogleToken(
  options: { revokeUrl: string; fetch?: typeof fetch },
  token: string,
): Promise<boolean> {
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(options.revokeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
}
