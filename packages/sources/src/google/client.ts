/**
 * Google Business Profile data-plane client functions (issue #123, Epic
 * #7): the reviews.list call the poller walks. Reviews live on the legacy
 * My Business **v4** surface (never migrated; ADR 0002 §2):
 *
 *   GET {v4BaseUrl}/v4/{parent=accounts/*\/locations/*}/reviews
 *       ?orderBy=updateTime desc&pageSize=50[&pageToken=…]
 *
 * Same injection posture as ./auth.ts: Worker-runtime clean (fetch only),
 * base URL from env (`GOOGLE_MYBUSINESS_V4_BASE_URL` — local dev and tests
 * point it at the fake GBP server, #130) and `fetch` replaceable in-process
 * (`fakeGbp.app.fetch`).
 *
 * The response body is returned as **parsed-but-unvalidated JSON**
 * (`unknown`) on purpose: the poller stores the page VERBATIM inside the
 * #125 artifact envelope — validation is the adapter's job at normalize
 * time, and a strict parse here would silently reshape provenance. The
 * poller reads the few fields it needs (cursor walking) with a lenient
 * safeParse of `gbpReviewsPageSchema`.
 *
 * NEVER-LOG(credentials): access tokens flow through here and must never
 * appear in logs or error messages.
 */

/** v4 `reviews.list` page cap — max AND default 50 (ADR 0002 §2). */
export const GBP_REVIEWS_MAX_PAGE_SIZE = 50;

/** The one documented ordering the incremental cursor relies on (#123). */
export const GBP_REVIEWS_ORDER_BY = "updateTime desc";

/**
 * A non-2xx from a GBP data endpoint. `retryable` follows Google's own
 * guidance (429 + 5xx are transient; 4xx are the caller's bug or a
 * permanent condition) and `retryAfterMs` carries a parsed `Retry-After`
 * header when Google sent one — the backoff loop must honor it.
 */
export class GbpApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  /** Parsed `Retry-After` (seconds or HTTP-date form), when present. */
  readonly retryAfterMs: number | undefined;

  constructor(what: string, status: number, retryAfterMs?: number) {
    // NEVER-LOG(credentials): message carries the endpoint + status only.
    super(`GBP ${what} failed with status ${status}`);
    this.name = "GbpApiError";
    this.status = status;
    this.retryable = status === 429 || status >= 500;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parse `Retry-After` — delta-seconds or HTTP-date (RFC 9110 §10.2.3). */
export function parseRetryAfterMs(
  header: string | null,
  nowMs: number = Date.now(),
): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}

export interface GbpApiConfig {
  /**
   * Origin of the My Business v4 host (no path): real
   * `https://mybusiness.googleapis.com`, fake `http://localhost:8799`.
   */
  v4BaseUrl: string;
  /** Injectable for tests (`fakeGbp.app.fetch`-backed). Default: global fetch. */
  fetch?: typeof fetch;
}

export interface ListReviewsPageInput {
  /** Bearer token from the #118 provider. NEVER-LOG(credentials). */
  accessToken: string;
  /** Account-scoped v4 location name: `accounts/{a}/locations/{l}`. */
  googleLocationName: string;
  /** From the previous page's `nextPageToken`. */
  pageToken?: string | undefined;
  /** Defaults to (and is capped at) {@link GBP_REVIEWS_MAX_PAGE_SIZE}. */
  pageSize?: number | undefined;
}

/**
 * One `reviews.list` page, `orderBy=updateTime desc`. Returns the response
 * body as parsed JSON (`unknown` — see module doc); throws
 * {@link GbpApiError} on any non-2xx.
 */
export async function listGbpReviewsPage(
  config: GbpApiConfig,
  input: ListReviewsPageInput,
): Promise<unknown> {
  const doFetch = config.fetch ?? fetch;
  const url = new URL(
    `/v4/${input.googleLocationName}/reviews`,
    config.v4BaseUrl,
  );
  url.searchParams.set("orderBy", GBP_REVIEWS_ORDER_BY);
  url.searchParams.set(
    "pageSize",
    String(
      Math.min(
        input.pageSize ?? GBP_REVIEWS_MAX_PAGE_SIZE,
        GBP_REVIEWS_MAX_PAGE_SIZE,
      ),
    ),
  );
  if (input.pageToken !== undefined) {
    url.searchParams.set("pageToken", input.pageToken);
  }

  const response = await doFetch(url.toString(), {
    headers: { Authorization: `Bearer ${input.accessToken}` },
  });
  if (!response.ok) {
    throw new GbpApiError(
      `reviews.list(${input.googleLocationName})`,
      response.status,
      parseRetryAfterMs(response.headers.get("Retry-After")),
    );
  }
  return response.json();
}
