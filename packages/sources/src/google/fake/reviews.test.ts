import { describe, expect, it } from "vitest";

import { createFakeGbp } from "./app.js";
import type { GbpReview, GbpReviewsListResponse } from "./types.js";

const REVIEWS_PATH = "/v4/accounts/1/locations/1/reviews";

function setup() {
  const { app, store } = createFakeGbp();
  store.addAccount();
  store.addLocation();
  const token = store.issueAccessToken();
  const get = (path: string) =>
    app.request(path, { headers: { Authorization: `Bearer ${token}` } });
  const listPage = async (query = ""): Promise<GbpReviewsListResponse> => {
    const res = await get(`${REVIEWS_PATH}${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as GbpReviewsListResponse;
  };
  /** Walk every page, returning reviews in served order. */
  const listAll = async (pageSize: number): Promise<GbpReview[]> => {
    const collected: GbpReview[] = [];
    let pageToken: string | undefined;
    do {
      const suffix: string = pageToken
        ? `&pageToken=${encodeURIComponent(pageToken)}`
        : "";
      const page = await listPage(`?pageSize=${pageSize}${suffix}`);
      collected.push(...(page.reviews ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return collected;
  };
  return { app, store, get, listPage, listAll };
}

describe("GET /v4/.../reviews", () => {
  it("404s for a location that does not exist", async () => {
    const { get } = setup();
    const res = await get("/v4/accounts/1/locations/99/reviews");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: { code: 404, status: "NOT_FOUND" },
    });
  });

  it("returns {} for a location with no reviews", async () => {
    const { listPage } = setup();
    expect(await listPage()).toEqual({});
  });

  it("serves the documented review shape, star-only reviews without a comment key", async () => {
    const { store, listPage } = setup();
    store.addReview({
      starRating: "FOUR",
      comment: "Gentle cleaning, zero wait.",
      reviewer: { displayName: "Jamie R." },
    });
    store.addReview({ starRating: "TWO" }); // star-only

    const page = await listPage();
    const [starOnly, commented] = page.reviews ?? [];
    expect(commented?.name).toBe("accounts/1/locations/1/reviews/1");
    expect(commented?.reviewId).toBe("1");
    expect(commented?.comment).toBe("Gentle cleaning, zero wait.");
    expect(starOnly?.starRating).toBe("TWO");
    expect(starOnly && "comment" in starOnly).toBe(false);
  });

  it("paginates the whole store in updateTime desc order, exactly once each", async () => {
    const { store, listAll } = setup();
    for (let i = 0; i < 8; i += 1) store.addReview();

    const collected = await listAll(3);
    expect(collected).toHaveLength(8);
    // Monotonic store clock ⇒ newest-added first.
    expect(collected.map((r) => r.reviewId)).toEqual([
      "8",
      "7",
      "6",
      "5",
      "4",
      "3",
      "2",
      "1",
    ]);
    const times = collected.map((r) => r.updateTime);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("editReview bumps updateTime and resorts the review to the front (#123's edit detection)", async () => {
    const { store, listAll } = setup();
    const oldest = store.addReview({
      comment: "Three stars.",
      starRating: "THREE",
    });
    for (let i = 0; i < 5; i += 1) store.addReview();
    const before = await listAll(2);
    expect(before.at(-1)?.name).toBe(oldest.name);
    const previousUpdateTime = oldest.updateTime;

    store.editReview(oldest.name, {
      comment: "Upgraded after a follow-up call!",
      starRating: "FIVE",
    });

    const after = await listAll(2);
    expect(after[0]?.name).toBe(oldest.name);
    expect(after[0]?.comment).toBe("Upgraded after a follow-up call!");
    expect(after[0]?.starRating).toBe("FIVE");
    expect(
      after[0]?.updateTime.localeCompare(previousUpdateTime),
    ).toBeGreaterThan(0);
    // createTime never moves on edit.
    expect(after[0]?.createTime).toBe(oldest.createTime);
    expect(after).toHaveLength(6);
  });

  it("deleteReview removes the review from listings", async () => {
    const { store, listAll } = setup();
    const first = store.addReview();
    store.addReview();
    store.deleteReview(first.name);
    expect((await listAll(50)).map((r) => r.name)).not.toContain(first.name);
  });

  it("carries averageRating and totalReviewCount on every page", async () => {
    const { store, listPage } = setup();
    store.addReview({ starRating: "FIVE" });
    store.addReview({ starRating: "FOUR" });
    store.addReview({ starRating: "ONE" });

    const page = await listPage("?pageSize=2");
    expect(page.totalReviewCount).toBe(3);
    expect(page.averageRating).toBeCloseTo(3.3, 5);
    const page2 = await listPage(
      `?pageSize=2&pageToken=${encodeURIComponent(page.nextPageToken ?? "")}`,
    );
    expect(page2.totalReviewCount).toBe(3);
    expect(page2.averageRating).toBeCloseTo(3.3, 5);
  });

  it("clamps pageSize to the v4 max of 50", async () => {
    const { store, listPage } = setup();
    for (let i = 0; i < 55; i += 1) store.addReview();
    const page = await listPage("?pageSize=500");
    expect(page.reviews).toHaveLength(50);
    expect(page.nextPageToken).toBeDefined();
  });

  it("supports the documented orderBy values and rejects others", async () => {
    const { store, listPage, get } = setup();
    store.addReview({ starRating: "THREE" });
    store.addReview({ starRating: "FIVE" });
    store.addReview({ starRating: "ONE" });

    const asc = await listPage("?orderBy=rating");
    expect(asc.reviews?.map((r) => r.starRating)).toEqual([
      "ONE",
      "THREE",
      "FIVE",
    ]);
    const desc = await listPage(
      `?orderBy=${encodeURIComponent("rating desc")}`,
    );
    expect(desc.reviews?.map((r) => r.starRating)).toEqual([
      "FIVE",
      "THREE",
      "ONE",
    ]);

    const invalid = await get(`${REVIEWS_PATH}?orderBy=createTime`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: 400, status: "INVALID_ARGUMENT" },
    });
  });

  it("rejects a garbage pageToken with INVALID_ARGUMENT", async () => {
    const { store, get } = setup();
    store.addReview();
    const res = await get(`${REVIEWS_PATH}?pageToken=not-a-token`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: 400, status: "INVALID_ARGUMENT" },
    });
  });

  it("respects explicit createTime/updateTime overrides (backdated fixtures)", async () => {
    const { store, listPage } = setup();
    store.addReview({
      createTime: "2025-02-01T10:00:00.000Z",
      updateTime: "2025-03-01T10:00:00.000Z",
    });
    const page = await listPage();
    expect(page.reviews?.[0]?.createTime).toBe("2025-02-01T10:00:00.000Z");
    expect(page.reviews?.[0]?.updateTime).toBe("2025-03-01T10:00:00.000Z");
  });
});
