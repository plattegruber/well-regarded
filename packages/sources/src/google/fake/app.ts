/**
 * The fake Google Business Profile server (issue #130, Epic #7).
 *
 * A Hono app mimicking the exact API surface ADR 0002 §2 documents:
 *
 * - `POST /oauth/token`                                — oauth2.googleapis.com
 * - `GET  /v1/accounts`                                — Account Management v1
 * - `GET  /v1/accounts/{a}/locations`                  — Business Information v1
 * - `GET  /v1/locations/{l}`                           — Business Information v1
 * - `GET  /v1/locations/{l}/VoiceOfMerchantState`      — Verifications v1
 * - `GET  /v4/accounts/{a}/locations/{l}/reviews`      — My Business v4
 * - `PUT  /v4/accounts/{a}/locations/{l}/reviews/{r}/reply` (+ DELETE)
 * - `GET  /v4/accounts/{a}/locations/{l}/media`        — My Business v4
 *
 * Real Google spreads these across five hosts; the fake serves them all
 * from one origin because every Google-calling module accepts an injectable
 * base URL / fetch (#118/#123/#127 requirement). In-process tests don't
 * even need a port: `app.fetch` routes on the path alone, so it can be
 * injected as the `fetch` implementation with the REAL Google URLs:
 *
 *     const { app, store } = createFakeGbp();
 *     const gbpFetch: typeof fetch = async (input, init) =>
 *       app.fetch(new Request(input, init));
 *     // now gbpFetch("https://mybusiness.googleapis.com/v4/.../reviews", …)
 *     // is answered by the fake — no server, no port, no race.
 *
 * This fake ships in the repo but never deploys; nothing in `infra/` or any
 * wrangler config references it.
 */

import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";

import { FakeGbpStore } from "./store.js";
import {
  type GbpAccountsListResponse,
  type GbpLocation,
  type GbpLocationsListResponse,
  type GbpMediaListResponse,
  type GbpReviewsListResponse,
  type GoogleApiError,
  type OauthTokenResponse,
  starRatingValue,
} from "./types.js";

export const GBP_OAUTH_SCOPE =
  "https://www.googleapis.com/auth/business.manage";

/** Default port for standalone mode (`pnpm dev:fake-gbp`); 8787-adjacent. */
export const FAKE_GBP_DEFAULT_PORT = 8799;

export interface FakeGbp {
  app: Hono;
  store: FakeGbpStore;
}

/** Location fields the fake accepts in `readMask` (a modeled subset of the real API's). */
const LOCATION_MASKABLE_FIELDS = new Set([
  "name",
  "title",
  "storefrontAddress",
  "phoneNumbers",
  "categories",
  "websiteUri",
  "regularHours",
  "specialHours",
  "profile",
  "metadata",
]);

/**
 * Build the fake GBP app. Pass a pre-configured {@link FakeGbpStore} to
 * control token TTL / initial reply-moderation state; otherwise a fresh
 * store is created and returned alongside the app.
 */
export function createFakeGbp(
  store: FakeGbpStore = new FakeGbpStore(),
): FakeGbp {
  const app = new Hono();

  // -- failure injection runs first so it can preempt anything, auth included.
  app.use("*", async (c, next) => {
    const failure = store.consumeFailure(
      c.req.method,
      new URL(c.req.url).pathname,
    );
    if (!failure) return next();
    if (failure.delayMs) await sleep(failure.delayMs);
    if (failure.status === undefined) return next(); // delay-only script
    const headers = new Headers({ "Content-Type": "application/json" });
    if (failure.status === 429) headers.set("Retry-After", "1");
    for (const [k, v] of Object.entries(failure.headers ?? {})) {
      headers.set(k, v);
    }
    const body = failure.body ?? defaultErrorBody(failure.status);
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      { status: failure.status, headers },
    );
  });

  // ---------------------------------------------------------------------
  // OAuth token endpoint (real host: oauth2.googleapis.com/token)
  // ---------------------------------------------------------------------

  app.post("/oauth/token", async (c) => {
    const params = await readTokenParams(c.req.raw);
    const grantType = params.get("grant_type");

    if (grantType === "authorization_code") {
      const code = params.get("code");
      const granted = code ? store.exchangeAuthCode(code) : undefined;
      if (!granted) {
        return c.json(
          { error: "invalid_grant", error_description: "Malformed auth code." },
          400,
        );
      }
      const body: OauthTokenResponse = {
        access_token: granted.accessToken,
        expires_in: granted.expiresIn,
        refresh_token: granted.refreshToken,
        scope: GBP_OAUTH_SCOPE,
        token_type: "Bearer",
      };
      return c.json(body);
    }

    if (grantType === "refresh_token") {
      const refreshToken = params.get("refresh_token");
      const granted = refreshToken
        ? store.refreshAccessToken(refreshToken)
        : undefined;
      if (!granted) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "Token has been expired or revoked.",
          },
          400,
        );
      }
      const body: OauthTokenResponse = {
        access_token: granted.accessToken,
        expires_in: granted.expiresIn,
        scope: GBP_OAUTH_SCOPE,
        token_type: "Bearer",
      };
      return c.json(body);
    }

    return c.json(
      {
        error: "unsupported_grant_type",
        error_description: `Invalid grant_type: ${grantType ?? "(missing)"}`,
      },
      400,
    );
  });

  // ---------------------------------------------------------------------
  // Bearer enforcement for every data endpoint. Shallow on purpose: the
  // token must be one the fake issued and unexpired — enough to catch
  // missing-token and stale-token bugs.
  // ---------------------------------------------------------------------

  const requireBearer: MiddlewareHandler = async (c, next) => {
    const token = c.req.header("Authorization")?.match(/^Bearer\s+(.+)$/)?.[1];
    if (!token || !store.isValidAccessToken(token)) {
      return googleError(
        401,
        "UNAUTHENTICATED",
        "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.",
      );
    }
    await next();
  };
  app.use("/v1/*", requireBearer);
  app.use("/v4/*", requireBearer);

  // ---------------------------------------------------------------------
  // Account Management v1
  // ---------------------------------------------------------------------

  app.get("/v1/accounts", (c) => {
    // Real accounts.list pages are small: default AND max 20 (ADR 0002 §2).
    const pageSize = clampPageSize(c.req.query("pageSize"), 20, 20);
    const paged = paginate(
      store.listAccounts(),
      pageSize,
      c.req.query("pageToken"),
    );
    if (!paged) return invalidPageToken();
    const body: GbpAccountsListResponse = {};
    if (paged.items.length > 0) body.accounts = paged.items;
    if (paged.nextPageToken) body.nextPageToken = paged.nextPageToken;
    return c.json(body);
  });

  // ---------------------------------------------------------------------
  // Business Information v1
  // ---------------------------------------------------------------------

  app.get("/v1/accounts/:accountId/locations", (c) => {
    const mask = parseReadMask(c.req.query("readMask"));
    if (mask instanceof Response) return mask;
    const account = `accounts/${c.req.param("accountId")}`;
    const pageSize = clampPageSize(c.req.query("pageSize"), 10, 100);
    const all = store.listLocations(account);
    const paged = paginate(all, pageSize, c.req.query("pageToken"));
    if (!paged) return invalidPageToken();
    const body: GbpLocationsListResponse = {};
    if (paged.items.length > 0) {
      body.locations = paged.items.map((l) => applyReadMask(l, mask));
    }
    if (paged.nextPageToken) body.nextPageToken = paged.nextPageToken;
    if (all.length > 0) body.totalSize = all.length;
    return c.json(body);
  });

  app.get("/v1/locations/:locationId", (c) => {
    const mask = parseReadMask(c.req.query("readMask"));
    if (mask instanceof Response) return mask;
    const location = store.getLocation(
      `locations/${c.req.param("locationId")}`,
    );
    if (!location) return notFound("Location not found.");
    return c.json(applyReadMask(location, mask));
  });

  // ---------------------------------------------------------------------
  // Verifications v1 — verified status the way real GBP exposes it (there
  // is no `verificationState` string on a v1 location).
  // ---------------------------------------------------------------------

  app.get("/v1/locations/:locationId/VoiceOfMerchantState", (c) => {
    const location = store.getLocation(
      `locations/${c.req.param("locationId")}`,
    );
    if (!location) return notFound("Location not found.");
    const verified = location.metadata?.hasVoiceOfMerchant === true;
    return c.json({ hasVoiceOfMerchant: verified, hasBusinessAuthority: true });
  });

  // ---------------------------------------------------------------------
  // My Business v4 — reviews (never migrated off v4; ADR 0002 §2)
  // ---------------------------------------------------------------------

  app.get("/v4/accounts/:accountId/locations/:locationId/reviews", (c) => {
    const accountId = c.req.param("accountId");
    const locationId = c.req.param("locationId");
    if (!store.hasV4Location(accountId, locationId)) {
      return notFound("Requested entity was not found.");
    }
    const orderBy = c.req.query("orderBy") ?? "updateTime desc";
    if (!["updateTime desc", "rating", "rating desc"].includes(orderBy)) {
      return googleError(
        400,
        "INVALID_ARGUMENT",
        `Invalid orderBy: ${orderBy}. Valid values are "rating", "rating desc" and "updateTime desc".`,
      );
    }
    // v4 reviews.list pages: max (and default) 50 — ADR 0002 §2.
    const pageSize = clampPageSize(c.req.query("pageSize"), 50, 50);
    const all = store
      .reviewsForV4Location(accountId, locationId)
      .sort(reviewComparator(orderBy));
    const paged = paginate(all, pageSize, c.req.query("pageToken"));
    if (!paged) return invalidPageToken();

    const body: GbpReviewsListResponse = {};
    if (paged.items.length > 0) body.reviews = paged.items;
    if (paged.nextPageToken) body.nextPageToken = paged.nextPageToken;
    if (all.length > 0) {
      body.totalReviewCount = all.length;
      const rated = all.filter((r) => starRatingValue(r.starRating) > 0);
      if (rated.length > 0) {
        const mean =
          rated.reduce((sum, r) => sum + starRatingValue(r.starRating), 0) /
          rated.length;
        body.averageRating = Math.round(mean * 10) / 10;
      }
    }
    return c.json(body);
  });

  app.put(
    "/v4/accounts/:accountId/locations/:locationId/reviews/:reviewId/reply",
    async (c) => {
      const accountId = c.req.param("accountId");
      const locationId = c.req.param("locationId");
      const name = `accounts/${accountId}/locations/${locationId}/reviews/${c.req.param("reviewId")}`;
      if (!store.getReview(name)) {
        return notFound("Requested entity was not found.");
      }
      // Google hard-blocks replies on unverified locations (ADR 0002 §2/§7;
      // #127 classifies this as a distinct permanent failure).
      if (!store.isV4LocationVerified(accountId, locationId)) {
        return googleError(
          400,
          "FAILED_PRECONDITION",
          "This operation is only valid if the specified location is verified.",
        );
      }
      const parsed = await c.req.json().catch(() => undefined);
      const comment =
        parsed && typeof parsed === "object" && "comment" in parsed
          ? (parsed as { comment: unknown }).comment
          : undefined;
      if (typeof comment !== "string" || comment.length === 0) {
        return googleError(
          400,
          "INVALID_ARGUMENT",
          "Review reply comment must not be empty.",
        );
      }
      // 4096 BYTES, not chars (ADR 0002 — emoji-heavy replies exceed it early).
      if (new TextEncoder().encode(comment).length > 4096) {
        return googleError(
          400,
          "INVALID_ARGUMENT",
          "Review reply comment must not exceed 4096 bytes.",
        );
      }
      return c.json(store.upsertReply(name, comment));
    },
  );

  app.delete(
    "/v4/accounts/:accountId/locations/:locationId/reviews/:reviewId/reply",
    (c) => {
      const name = `accounts/${c.req.param("accountId")}/locations/${c.req.param(
        "locationId",
      )}/reviews/${c.req.param("reviewId")}`;
      if (!store.getReview(name)) {
        return notFound("Requested entity was not found.");
      }
      if (!store.deleteReply(name)) {
        return notFound("Review reply not found.");
      }
      return c.json({});
    },
  );

  // ---------------------------------------------------------------------
  // My Business v4 — media (photo count for Presence, #156)
  // ---------------------------------------------------------------------

  app.get("/v4/accounts/:accountId/locations/:locationId/media", (c) => {
    const accountId = c.req.param("accountId");
    const locationId = c.req.param("locationId");
    if (!store.hasV4Location(accountId, locationId)) {
      return notFound("Requested entity was not found.");
    }
    const total = store.mediaItemCount(accountId, locationId);
    const body: GbpMediaListResponse = {};
    if (total > 0) {
      body.totalMediaItemCount = total;
      body.mediaItems = Array.from(
        { length: Math.min(total, 100) },
        (_, i) => ({
          name: `accounts/${accountId}/locations/${locationId}/media/${i + 1}`,
          mediaFormat: "PHOTO" as const,
          googleUrl: `https://lh3.googleusercontent.com/fake-media-${locationId}-${i + 1}`,
        }),
      );
    }
    return c.json(body);
  });

  app.notFound(() => notFound("Requested entity was not found."));

  return { app, store };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Google JSON error envelope, as the v1/v4 HTTP front ends render it. */
function googleError(code: number, status: string, message: string): Response {
  const body: GoogleApiError = { error: { code, message, status } };
  return new Response(JSON.stringify(body), {
    status: code,
    headers: { "Content-Type": "application/json" },
  });
}

function notFound(message: string): Response {
  return googleError(404, "NOT_FOUND", message);
}

function invalidPageToken(): Response {
  return googleError(400, "INVALID_ARGUMENT", "Invalid pageToken provided.");
}

function defaultErrorBody(status: number): GoogleApiError {
  const statusName: Record<number, string> = {
    400: "INVALID_ARGUMENT",
    401: "UNAUTHENTICATED",
    403: "PERMISSION_DENIED",
    404: "NOT_FOUND",
    429: "RESOURCE_EXHAUSTED",
    500: "INTERNAL",
    502: "UNAVAILABLE",
    503: "UNAVAILABLE",
  };
  const messages: Record<number, string> = {
    429: "Quota exceeded for quota metric 'Requests' and limit 'Requests per minute' of service 'mybusiness.googleapis.com'.",
    500: "Internal error encountered.",
    503: "The service is currently unavailable.",
  };
  return {
    error: {
      code: status,
      message: messages[status] ?? "Injected failure from the fake GBP server.",
      status: statusName[status] ?? "UNKNOWN",
    },
  };
}

/**
 * The token endpoint takes application/x-www-form-urlencoded params (like
 * real Google); JSON bodies are accepted too as a test convenience.
 */
async function readTokenParams(request: Request): Promise<URLSearchParams> {
  const text = await request.text();
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const parsed: unknown = JSON.parse(text);
      const params = new URLSearchParams();
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string") params.set(k, v);
        }
      }
      return params;
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(text);
}

function clampPageSize(
  raw: string | undefined,
  defaultSize: number,
  maxSize: number,
): number {
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return defaultSize;
  return Math.min(parsed, maxSize);
}

/**
 * Offset cursor encoded as an opaque base64 token. Like the real API's
 * tokens it is meaningless to clients; unlike the real API it is a plain
 * offset, so a store mutation mid-walk can shift items across page
 * boundaries (real Google has equivalent races — pollers must dedupe by
 * review `name` anyway).
 */
function paginate<T>(
  items: T[],
  pageSize: number,
  pageToken: string | undefined,
): { items: T[]; nextPageToken?: string } | undefined {
  let offset = 0;
  if (pageToken !== undefined && pageToken !== "") {
    try {
      const decoded: unknown = JSON.parse(atob(fromBase64Url(pageToken)));
      if (
        !decoded ||
        typeof decoded !== "object" ||
        typeof (decoded as { o: unknown }).o !== "number"
      ) {
        return undefined;
      }
      offset = (decoded as { o: number }).o;
    } catch {
      return undefined;
    }
  }
  const page = items.slice(offset, offset + pageSize);
  const next = offset + pageSize;
  if (next < items.length) {
    return {
      items: page,
      nextPageToken: toBase64Url(btoa(JSON.stringify({ o: next }))),
    };
  }
  return { items: page };
}

/** Real Google page tokens are URL-safe; keep the fake's that way too. */
function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(token: string): string {
  const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
  return base64 + "=".repeat((4 - (base64.length % 4)) % 4);
}

type ReviewForSort = {
  name: string;
  updateTime: string;
  starRating: Parameters<typeof starRatingValue>[0];
};

function reviewComparator(
  orderBy: string,
): (a: ReviewForSort, b: ReviewForSort) => number {
  const byUpdateTimeDesc = (a: ReviewForSort, b: ReviewForSort) =>
    b.updateTime.localeCompare(a.updateTime) || a.name.localeCompare(b.name);
  if (orderBy === "rating") {
    return (a, b) =>
      starRatingValue(a.starRating) - starRatingValue(b.starRating) ||
      byUpdateTimeDesc(a, b);
  }
  if (orderBy === "rating desc") {
    return (a, b) =>
      starRatingValue(b.starRating) - starRatingValue(a.starRating) ||
      byUpdateTimeDesc(a, b);
  }
  return byUpdateTimeDesc;
}

/**
 * `readMask` handling: required (400 without it, like real Business
 * Information), `*` means everything, and unknown top-level fields are
 * rejected. Nested paths (`profile.description`) select the whole
 * top-level field — a documented simplification.
 */
function parseReadMask(raw: string | undefined): Set<string> | "*" | Response {
  if (!raw) {
    return googleError(
      400,
      "INVALID_ARGUMENT",
      "Read mask is required. Specify a readMask query parameter (see https://developers.google.com/my-business/reference/businessinformation/rest/v1/accounts.locations/list).",
    );
  }
  if (raw === "*") return "*";
  const fields = new Set<string>();
  for (const path of raw.split(",")) {
    const top = path.trim().split(".")[0] ?? "";
    if (!LOCATION_MASKABLE_FIELDS.has(top)) {
      return googleError(
        400,
        "INVALID_ARGUMENT",
        `Invalid field mask provided: '${path.trim()}' is not a known Location field (the fake models: ${[...LOCATION_MASKABLE_FIELDS].join(", ")}).`,
      );
    }
    fields.add(top);
  }
  return fields;
}

function applyReadMask(
  location: GbpLocation,
  mask: Set<string> | "*",
): GbpLocation {
  if (mask === "*") return location;
  const out: Record<string, unknown> = {};
  for (const field of mask) {
    const value = (location as unknown as Record<string, unknown>)[field];
    if (value !== undefined) out[field] = value;
  }
  return out as unknown as GbpLocation;
}
