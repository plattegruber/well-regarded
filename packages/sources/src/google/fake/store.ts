/**
 * Mutable in-memory store behind the fake GBP server (issue #130, Epic #7).
 *
 * Tests drive this DIRECTLY (not via HTTP): seed accounts/locations/reviews,
 * edit a review to simulate Google-side changes between polls (#123's
 * incremental-sync tests, #106/#125's edit tests), flip a reply's moderation
 * state (#127's rejection detection), script failures (`failNext`), and
 * manipulate OAuth tokens (#118's expiry/`invalid_grant` paths).
 *
 * Everything is deterministic: ids come from per-store counters, tokens are
 * `fake-access-token-N` / `fake-refresh-token-N`, and timestamps from the
 * internal clock are monotonic (each mutation is at least 1s after the
 * previous one) so `updateTime desc` ordering is always well-defined.
 */

import type {
  GbpAccount,
  GbpLocation,
  GbpReview,
  GbpReviewReply,
  ReviewReplyState,
  StarRating,
} from "./types.js";

/** How `failNext` picks requests: substring of `"METHOD /path"`, regex, or predicate. */
export type EndpointMatcher =
  | string
  | RegExp
  | ((method: string, path: string) => boolean);

export interface FailNextOptions {
  /**
   * HTTP status for the injected response. Omit it (with `delayMs` set) to
   * delay the request and then let the real handler answer.
   */
  status?: number;
  /** How many matching requests to affect. Default 1. */
  times?: number;
  /** Response body. Defaults to a Google-style error for the status. */
  body?: unknown;
  /** Extra headers. A 429 gets `Retry-After: 1` unless overridden here. */
  headers?: Record<string, string>;
  /** Delay before responding (failure or passthrough), in ms. */
  delayMs?: number;
}

interface FailureScript {
  matcher: EndpointMatcher;
  status?: number;
  times: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

/** A matched `failNext` script, consumed for one request. */
export interface ConsumedFailure {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

export interface FakeGbpStoreOptions {
  /** Lifetime of issued access tokens. Default 3600 (Google returns ~3599). */
  accessTokenTtlSeconds?: number;
  /**
   * `reviewReplyState` a fresh reply gets from the PUT (owner replies are
   * moderated since 2026-04-01 — ADR 0002). Default "PENDING"; use
   * `setReplyState` to simulate the asynchronous APPROVED/REJECTED outcome.
   */
  initialReplyState?: ReviewReplyState;
  /**
   * Injectable time source (ms since epoch) for fully deterministic
   * timestamps/token expiry — the fixture-file renderer pins it to
   * `FIXTURE_EPOCH`. Default: `Date.now`.
   */
  clock?: () => number;
}

interface LocationRecord {
  resource: GbpLocation;
  /** Owning account resource name (`accounts/{a}`) — v1 locations don't carry it. */
  account: string;
  locationId: string;
  /** Backs the v4 media surface's `totalMediaItemCount` (#156). */
  mediaItemCount: number;
}

export type AddLocationOverrides = Partial<GbpLocation> & {
  /** Owning account (`accounts/{a}`). Default: the last-added account. */
  account?: string;
  /** Sets `metadata.hasVoiceOfMerchant`. Default true (verified). */
  verified?: boolean;
  /** Photo/video count reported by the v4 media endpoint. Default 0. */
  mediaItemCount?: number;
};

export type AddReviewOverrides = Partial<GbpReview> & {
  /**
   * Target location: `locations/{l}` or `accounts/{a}/locations/{l}`.
   * Default: the last-added location.
   */
  location?: string;
};

export class FakeGbpStore {
  accessTokenTtlSeconds: number;
  initialReplyState: ReviewReplyState;

  private accounts: GbpAccount[] = [];
  private locations: LocationRecord[] = [];
  private reviews = new Map<string, GbpReview>();

  private authCodes = new Set<string>();
  private refreshTokens = new Set<string>();
  private accessTokens = new Map<string, number>(); // token -> expiresAt (ms)

  private failures: FailureScript[] = [];

  private counters = {
    account: 0,
    location: 0,
    review: 0,
    code: 0,
    accessToken: 0,
    refreshToken: 0,
  };
  private lastTimestampMs = 0;

  private readonly clock: () => number;

  constructor(options: FakeGbpStoreOptions = {}) {
    this.accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 3600;
    this.initialReplyState = options.initialReplyState ?? "PENDING";
    this.clock = options.clock ?? Date.now;
  }

  /** Wipe everything: data, tokens, failure scripts, counters, the clock. */
  reset(): void {
    this.accounts = [];
    this.locations = [];
    this.reviews.clear();
    this.authCodes.clear();
    this.refreshTokens.clear();
    this.accessTokens.clear();
    this.failures = [];
    this.counters = {
      account: 0,
      location: 0,
      review: 0,
      code: 0,
      accessToken: 0,
      refreshToken: 0,
    };
    this.lastTimestampMs = 0;
  }

  // -------------------------------------------------------------------------
  // Clock — monotonic so `updateTime desc` never ties by accident.
  // -------------------------------------------------------------------------

  /** Next mutation timestamp: real time, but ≥ 1s after the previous one. */
  touch(): string {
    this.lastTimestampMs = Math.max(this.clock(), this.lastTimestampMs + 1000);
    return new Date(this.lastTimestampMs).toISOString();
  }

  /** Keep the monotonic clock ahead of explicitly-provided timestamps. */
  private observeTimestamp(iso: string): void {
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) {
      this.lastTimestampMs = Math.max(this.lastTimestampMs, ms);
    }
  }

  // -------------------------------------------------------------------------
  // Accounts & locations
  // -------------------------------------------------------------------------

  addAccount(overrides: Partial<GbpAccount> = {}): GbpAccount {
    this.counters.account += 1;
    const account: GbpAccount = {
      name: `accounts/${this.counters.account}`,
      accountName: `Fake Practice ${this.counters.account}`,
      type: "PERSONAL",
      role: "PRIMARY_OWNER",
      verificationState: "VERIFIED",
      vettedState: "NOT_VETTED",
      ...overrides,
    };
    this.accounts.push(account);
    return account;
  }

  addLocation(overrides: AddLocationOverrides = {}): GbpLocation {
    const {
      account = this.accounts.at(-1)?.name,
      verified = true,
      mediaItemCount = 0,
      ...resourceOverrides
    } = overrides;
    if (!account) {
      throw new Error(
        "addLocation: no account in the store — call addAccount() first or pass { account }",
      );
    }
    this.counters.location += 1;
    const locationId = String(this.counters.location);
    const { metadata: metadataOverrides, ...rest } = resourceOverrides;
    const resource: GbpLocation = {
      name: `locations/${locationId}`,
      title: `Fake Location ${locationId}`,
      ...stripUndefined(rest),
      metadata: {
        hasVoiceOfMerchant: verified,
        placeId: `fake-place-${locationId}`,
        mapsUri: `https://maps.google.com/?cid=fake-${locationId}`,
        newReviewUri: `https://search.google.com/local/writereview?placeid=fake-place-${locationId}`,
        ...metadataOverrides,
      },
    };
    this.locations.push({
      resource,
      account,
      locationId: resource.name.split("/")[1] ?? locationId,
      mediaItemCount,
    });
    return resource;
  }

  listAccounts(): GbpAccount[] {
    return [...this.accounts];
  }

  /** Locations owned by `accounts/{a}` (v1 list order = insertion order). */
  listLocations(account: string): GbpLocation[] {
    return this.locations
      .filter((r) => r.account === account)
      .map((r) => r.resource);
  }

  /** Lookup by `locations/{l}` name. */
  getLocation(name: string): GbpLocation | undefined {
    return this.locations.find((r) => r.resource.name === name)?.resource;
  }

  /** Lookup by v4-style account-scoped path `accounts/{a}/locations/{l}`. */
  private locationRecordByV4Path(
    account: string,
    locationId: string,
  ): LocationRecord | undefined {
    return this.locations.find(
      (r) => r.account === `accounts/${account}` && r.locationId === locationId,
    );
  }

  hasV4Location(account: string, locationId: string): boolean {
    return this.locationRecordByV4Path(account, locationId) !== undefined;
  }

  isV4LocationVerified(account: string, locationId: string): boolean {
    return (
      this.locationRecordByV4Path(account, locationId)?.resource.metadata
        ?.hasVoiceOfMerchant === true
    );
  }

  mediaItemCount(account: string, locationId: string): number {
    return (
      this.locationRecordByV4Path(account, locationId)?.mediaItemCount ?? 0
    );
  }

  // -------------------------------------------------------------------------
  // Reviews
  // -------------------------------------------------------------------------

  private resolveLocationForReview(location?: string): LocationRecord {
    if (this.locations.length === 0) {
      throw new Error(
        "addReview: no location in the store — call addLocation() first or pass { location }",
      );
    }
    if (!location) {
      const last = this.locations.at(-1);
      if (!last) throw new Error("unreachable: locations is non-empty");
      return last;
    }
    const v4 = location.match(/^accounts\/([^/]+)\/locations\/([^/]+)$/);
    const record = v4
      ? this.locations.find(
          (r) => r.account === `accounts/${v4[1]}` && r.locationId === v4[2],
        )
      : this.locations.find((r) => r.resource.name === location);
    if (!record) throw new Error(`addReview: unknown location: ${location}`);
    return record;
  }

  addReview(overrides: AddReviewOverrides = {}): GbpReview {
    const { location, ...resourceOverrides } = overrides;
    const record = this.resolveLocationForReview(location);
    this.counters.review += 1;
    const reviewId = String(this.counters.review);
    const createTime = resourceOverrides.createTime ?? this.touch();
    const updateTime = resourceOverrides.updateTime ?? createTime;
    const review: GbpReview = {
      name: `accounts/${accountId(record.account)}/locations/${record.locationId}/reviews/${reviewId}`,
      reviewId,
      reviewer: { displayName: `Fake Reviewer ${reviewId}` },
      starRating: "FIVE",
      ...stripUndefined({ ...resourceOverrides }),
      createTime,
      updateTime,
    };
    this.observeTimestamp(review.updateTime);
    this.reviews.set(review.name, review);
    return review;
  }

  /**
   * Simulate the reviewer editing their review on Google. Bumps
   * `updateTime` — the review resorts to the top of `updateTime desc`
   * listings, which is exactly how #123's incremental sync notices edits.
   */
  editReview(
    name: string,
    changes: { comment?: string; starRating?: StarRating },
  ): GbpReview {
    const review = this.mustGetReview(name);
    if (changes.comment !== undefined) review.comment = changes.comment;
    if (changes.starRating !== undefined)
      review.starRating = changes.starRating;
    review.updateTime = this.touch();
    return review;
  }

  deleteReview(name: string): void {
    this.mustGetReview(name);
    this.reviews.delete(name);
  }

  getReview(name: string): GbpReview | undefined {
    return this.reviews.get(name);
  }

  private mustGetReview(name: string): GbpReview {
    const review = this.reviews.get(name);
    if (!review) throw new Error(`Unknown review: ${name}`);
    return review;
  }

  /** All reviews under `accounts/{a}/locations/{l}`, unordered. */
  reviewsForV4Location(account: string, locationId: string): GbpReview[] {
    const prefix = `accounts/${account}/locations/${locationId}/reviews/`;
    return [...this.reviews.values()].filter((r) => r.name.startsWith(prefix));
  }

  /**
   * Upsert the owner reply ("A reply is created if one does not exist").
   * Also bumps the review's `updateTime` so pollers re-see the review —
   * an assumption about real GBP, flagged in the README fidelity table.
   */
  upsertReply(name: string, comment: string): GbpReviewReply {
    const review = this.mustGetReview(name);
    const reply: GbpReviewReply = {
      comment,
      updateTime: this.touch(),
      reviewReplyState: this.initialReplyState,
    };
    review.reviewReply = reply;
    review.updateTime = reply.updateTime;
    return reply;
  }

  deleteReply(name: string): boolean {
    const review = this.mustGetReview(name);
    if (!review.reviewReply) return false;
    delete review.reviewReply;
    review.updateTime = this.touch();
    return true;
  }

  /**
   * Simulate Google's asynchronous reply moderation (#127): flip the stored
   * reply to APPROVED / REJECTED (with `policyViolation` as the rejection
   * reason) / back to PENDING. Bumps the review's `updateTime` so the
   * poller's next incremental sync picks the change up.
   */
  setReplyState(
    name: string,
    state: ReviewReplyState,
    policyViolation?: string,
  ): GbpReviewReply {
    const review = this.mustGetReview(name);
    const reply = review.reviewReply;
    if (!reply) throw new Error(`Review has no reply to moderate: ${name}`);
    reply.reviewReplyState = state;
    if (state === "REJECTED" && policyViolation !== undefined) {
      reply.policyViolation = policyViolation;
    } else {
      delete reply.policyViolation;
    }
    review.updateTime = this.touch();
    return reply;
  }

  // -------------------------------------------------------------------------
  // OAuth
  // -------------------------------------------------------------------------

  /** Mint a single-use authorization code, as if consent just completed. */
  issueAuthCode(): string {
    this.counters.code += 1;
    const code = `fake-auth-code-${this.counters.code}`;
    this.authCodes.add(code);
    return code;
  }

  /** Consume an auth code. Returns tokens, or undefined (→ invalid_grant). */
  exchangeAuthCode(
    code: string,
  ):
    | { accessToken: string; refreshToken: string; expiresIn: number }
    | undefined {
    if (!this.authCodes.delete(code)) return undefined;
    this.counters.refreshToken += 1;
    const refreshToken = `fake-refresh-token-${this.counters.refreshToken}`;
    this.refreshTokens.add(refreshToken);
    return {
      accessToken: this.issueAccessToken(),
      refreshToken,
      expiresIn: this.accessTokenTtlSeconds,
    };
  }

  /** Refresh grant. Returns a new access token, or undefined (→ invalid_grant). */
  refreshAccessToken(
    refreshToken: string,
  ): { accessToken: string; expiresIn: number } | undefined {
    if (!this.refreshTokens.has(refreshToken)) return undefined;
    return {
      accessToken: this.issueAccessToken(),
      expiresIn: this.accessTokenTtlSeconds,
    };
  }

  /**
   * Mint a valid bearer directly, skipping the OAuth dance — the shortcut
   * for tests that only exercise the data endpoints.
   */
  issueAccessToken(): string {
    this.counters.accessToken += 1;
    const token = `fake-access-token-${this.counters.accessToken}`;
    this.accessTokens.set(
      token,
      this.clock() + this.accessTokenTtlSeconds * 1000,
    );
    return token;
  }

  /** True when the bearer was issued by this store and hasn't expired. */
  isValidAccessToken(token: string): boolean {
    const expiresAt = this.accessTokens.get(token);
    return expiresAt !== undefined && expiresAt > this.clock();
  }

  /** Force-expire outstanding access tokens (the #118 expiry-flow lever). */
  expireAccessTokens(): void {
    for (const token of this.accessTokens.keys()) {
      this.accessTokens.set(token, 0);
    }
  }

  /**
   * Invalidate a refresh token — subsequent refresh grants get
   * `invalid_grant`, the trigger for #118's `needs_reauth` path (real
   * Google does this on user revocation and Testing-status 7-day expiry).
   */
  revokeRefreshToken(refreshToken: string): void {
    this.refreshTokens.delete(refreshToken);
  }

  // -------------------------------------------------------------------------
  // Failure scripting
  // -------------------------------------------------------------------------

  /**
   * Script the next `times` requests matching `matcher` to fail (or, with
   * only `delayMs`, to be delayed). One mechanism powers all the
   * failure-mode tests: 429 backoff (#123), transient-then-success and
   * permanent failure (#127), `invalid_grant` (#118).
   *
   *     store.failNext("GET /v4/", { status: 429, times: 2 });
   *     store.failNext(/\/oauth\/token$/, {
   *       status: 400,
   *       body: { error: "invalid_grant", error_description: "Token revoked." },
   *     });
   */
  failNext(matcher: EndpointMatcher, options: FailNextOptions = {}): void {
    const script: FailureScript = { matcher, times: options.times ?? 1 };
    if (options.status !== undefined) script.status = options.status;
    if (options.body !== undefined) script.body = options.body;
    if (options.headers !== undefined) script.headers = options.headers;
    if (options.delayMs !== undefined) script.delayMs = options.delayMs;
    this.failures.push(script);
  }

  /** Called by the app on every request; consumes one matching script use. */
  consumeFailure(method: string, path: string): ConsumedFailure | undefined {
    const index = this.failures.findIndex((f) =>
      matches(f.matcher, method, path),
    );
    if (index === -1) return undefined;
    const script = this.failures[index];
    if (!script) return undefined;
    script.times -= 1;
    if (script.times <= 0) this.failures.splice(index, 1);
    const consumed: ConsumedFailure = {};
    if (script.status !== undefined) consumed.status = script.status;
    if (script.body !== undefined) consumed.body = script.body;
    if (script.headers !== undefined) consumed.headers = script.headers;
    if (script.delayMs !== undefined) consumed.delayMs = script.delayMs;
    return consumed;
  }
}

function matches(
  matcher: EndpointMatcher,
  method: string,
  path: string,
): boolean {
  const subject = `${method.toUpperCase()} ${path}`;
  if (typeof matcher === "string") {
    return subject.toUpperCase().includes(matcher.toUpperCase());
  }
  if (matcher instanceof RegExp) return matcher.test(subject);
  return matcher(method, path);
}

/** `accounts/{a}` → `{a}`. */
function accountId(accountName: string): string {
  return accountName.split("/")[1] ?? accountName;
}

/**
 * Drop `undefined`-valued keys so spreads never materialize explicit
 * `undefined` (proto3 JSON omits absent fields; `exactOptionalPropertyTypes`
 * expects real absence).
 */
function stripUndefined<T extends object>(obj: T): T {
  for (const key of Object.keys(obj) as Array<keyof T>) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}
