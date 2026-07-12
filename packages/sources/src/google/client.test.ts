/**
 * Unit tests for the v4 reviews.list client (issue #123): URL/param shape,
 * pagination pass-through, verbatim body, typed error classification, and
 * Retry-After parsing. All HTTP goes to the in-process fake GBP server via
 * injected fetch — no network.
 */

import { describe, expect, it } from "vitest";
import {
  GBP_REVIEWS_MAX_PAGE_SIZE,
  GbpApiError,
  listGbpReviewsPage,
  parseRetryAfterMs,
} from "./client.js";
import { createFakeGbp } from "./fake/index.js";
import { gbpReviewsPageSchema } from "./schema.js";

const BASE_URL = "http://fake-gbp.local";

function fakeFetch(app: {
  fetch: (req: Request) => Response | Promise<Response>;
}) {
  const urls: URL[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    urls.push(new URL(request.url));
    return app.fetch(request.clone());
  };
  return { doFetch, urls };
}

function seededFake(reviewCount: number) {
  const { app, store } = createFakeGbp();
  store.addAccount();
  store.addLocation();
  for (let i = 0; i < reviewCount; i++) {
    store.addReview({ comment: `Review ${i}` });
  }
  return { app, store, accessToken: store.issueAccessToken() };
}

describe("listGbpReviewsPage", () => {
  it("fetches a page ordered by updateTime desc with the max page size", async () => {
    const { app, accessToken } = seededFake(3);
    const { doFetch, urls } = fakeFetch(app);
    const body = await listGbpReviewsPage(
      { v4BaseUrl: BASE_URL, fetch: doFetch },
      { accessToken, googleLocationName: "accounts/1/locations/1" },
    );

    const url = urls[0];
    expect(url?.pathname).toBe("/v4/accounts/1/locations/1/reviews");
    expect(url?.searchParams.get("orderBy")).toBe("updateTime desc");
    expect(url?.searchParams.get("pageSize")).toBe(
      String(GBP_REVIEWS_MAX_PAGE_SIZE),
    );

    const page = gbpReviewsPageSchema.parse(body);
    expect(page.reviews).toHaveLength(3);
    expect(page.totalReviewCount).toBe(3);
  });

  it("passes pageToken through and pages the full set", async () => {
    const { app, accessToken } = seededFake(5);
    const { doFetch } = fakeFetch(app);
    const config = { v4BaseUrl: BASE_URL, fetch: doFetch };
    const input = {
      accessToken,
      googleLocationName: "accounts/1/locations/1",
      pageSize: 2,
    };

    const first = gbpReviewsPageSchema.parse(
      await listGbpReviewsPage(config, input),
    );
    expect(first.reviews).toHaveLength(2);
    expect(first.nextPageToken).toBeDefined();

    const second = gbpReviewsPageSchema.parse(
      await listGbpReviewsPage(config, {
        ...input,
        pageToken: first.nextPageToken,
      }),
    );
    expect(second.reviews).toHaveLength(2);

    const third = gbpReviewsPageSchema.parse(
      await listGbpReviewsPage(config, {
        ...input,
        pageToken: second.nextPageToken,
      }),
    );
    expect(third.reviews).toHaveLength(1);
    expect(third.nextPageToken).toBeUndefined();
  });

  it("clamps pageSize to the v4 max of 50", async () => {
    const { app, accessToken } = seededFake(1);
    const { doFetch, urls } = fakeFetch(app);
    await listGbpReviewsPage(
      { v4BaseUrl: BASE_URL, fetch: doFetch },
      {
        accessToken,
        googleLocationName: "accounts/1/locations/1",
        pageSize: 500,
      },
    );
    expect(urls[0]?.searchParams.get("pageSize")).toBe("50");
  });

  it("throws a retryable GbpApiError carrying Retry-After on a 429", async () => {
    const { app, store, accessToken } = seededFake(1);
    // The fake stamps `Retry-After: 1` on injected 429s.
    store.failNext("GET /v4/accounts/1/locations/1/reviews", { status: 429 });
    const { doFetch } = fakeFetch(app);
    const error = await listGbpReviewsPage(
      { v4BaseUrl: BASE_URL, fetch: doFetch },
      { accessToken, googleLocationName: "accounts/1/locations/1" },
    ).then(
      () => {
        throw new Error("expected a GbpApiError");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GbpApiError);
    const apiError = error as GbpApiError;
    expect(apiError.status).toBe(429);
    expect(apiError.retryable).toBe(true);
    expect(apiError.retryAfterMs).toBe(1000);
  });

  it("classifies 5xx retryable and 4xx permanent", async () => {
    const { app, store, accessToken } = seededFake(1);
    const { doFetch } = fakeFetch(app);
    const config = { v4BaseUrl: BASE_URL, fetch: doFetch };

    store.failNext("GET /v4/accounts/1/locations/1/reviews", { status: 503 });
    await expect(
      listGbpReviewsPage(config, {
        accessToken,
        googleLocationName: "accounts/1/locations/1",
      }),
    ).rejects.toMatchObject({ status: 503, retryable: true });

    // Unknown location → the fake's 404, permanent.
    await expect(
      listGbpReviewsPage(config, {
        accessToken,
        googleLocationName: "accounts/9/locations/9",
      }),
    ).rejects.toMatchObject({ status: 404, retryable: false });
  });

  it("never leaks the access token in error messages", async () => {
    const { app, store } = seededFake(1);
    store.failNext("GET /v4/accounts/1/locations/1/reviews", { status: 429 });
    const { doFetch } = fakeFetch(app);
    const error = (await listGbpReviewsPage(
      { v4BaseUrl: BASE_URL, fetch: doFetch },
      {
        accessToken: "super-secret-token",
        googleLocationName: "accounts/1/locations/1",
      },
    ).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain("super-secret-token");
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("30")).toBe(30_000);
  });

  it("parses HTTP-dates relative to now", () => {
    const now = Date.parse("2026-07-11T00:00:00Z");
    expect(parseRetryAfterMs("Sat, 11 Jul 2026 00:00:10 GMT", now)).toBe(
      10_000,
    );
  });

  it("clamps past HTTP-dates to zero and rejects garbage", () => {
    const now = Date.parse("2026-07-11T00:00:00Z");
    expect(parseRetryAfterMs("Fri, 10 Jul 2026 23:59:00 GMT", now)).toBe(0);
    expect(parseRetryAfterMs("soonish", now)).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });
});
