import { describe, expect, it } from "vitest";

import { createFakeGbp } from "./app.js";
import { FakeGbpStore } from "./store.js";
import type { GbpReviewReply, GbpReviewsListResponse } from "./types.js";

const REPLY_PATH = "/v4/accounts/1/locations/1/reviews/1/reply";

function setup(store = new FakeGbpStore()) {
  const { app } = createFakeGbp(store);
  store.addAccount();
  store.addLocation();
  const token = store.issueAccessToken();
  const putReply = (comment: string, path = REPLY_PATH) =>
    app.request(path, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ comment }),
    });
  const listReviews = async (): Promise<GbpReviewsListResponse> =>
    (await (
      await app.request("/v4/accounts/1/locations/1/reviews", {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as GbpReviewsListResponse;
  return { app, store, token, putReply, listReviews };
}

describe("PUT /v4/.../reviews/{r}/reply", () => {
  it("creates the reply, returns it with updateTime and the moderation state", async () => {
    const { store, putReply, listReviews } = setup();
    const review = store.addReview();

    const res = await putReply("Thank you for the kind words!");
    expect(res.status).toBe(200);
    const reply = (await res.json()) as GbpReviewReply;
    expect(reply.comment).toBe("Thank you for the kind words!");
    // Owner replies are moderated since 2026-04-01: a 200 does NOT mean
    // the reply is live (ADR 0002). Fresh replies report PENDING.
    expect(reply.reviewReplyState).toBe("PENDING");

    // Round-trip: the reply is on the review, and the review's updateTime
    // was bumped so the poller re-sees it.
    const listed = (await listReviews()).reviews?.[0];
    expect(listed?.reviewReply).toEqual(reply);
    expect(listed?.updateTime.localeCompare(review.createTime)).toBeGreaterThan(
      0,
    );
  });

  it("is an upsert: a second PUT replaces the reply", async () => {
    const { store, putReply, listReviews } = setup();
    store.addReview();
    await putReply("First draft.");
    const res = await putReply("Final wording.");
    expect(res.status).toBe(200);
    expect((await listReviews()).reviews?.[0]?.reviewReply?.comment).toBe(
      "Final wording.",
    );
  });

  it("honors the initialReplyState store option", async () => {
    const { store, putReply } = setup(
      new FakeGbpStore({ initialReplyState: "APPROVED" }),
    );
    store.addReview();
    const reply = (await (await putReply("Thanks!")).json()) as GbpReviewReply;
    expect(reply.reviewReplyState).toBe("APPROVED");
  });

  it("enforces the 4096-BYTE cap (bytes, not characters)", async () => {
    const { store, putReply } = setup();
    store.addReview();

    expect((await putReply("a".repeat(4096))).status).toBe(200);
    expect((await putReply("a".repeat(4097))).status).toBe(400);
    // 1025 four-byte emoji = 1025 chars but 4100 bytes — must be rejected.
    const emoji = await putReply("💚".repeat(1025));
    expect(emoji.status).toBe(400);
    expect(await emoji.json()).toMatchObject({
      error: { code: 400, status: "INVALID_ARGUMENT" },
    });
  });

  it("rejects an empty or missing comment and malformed JSON", async () => {
    const { app, store, token, putReply } = setup();
    store.addReview();
    expect((await putReply("")).status).toBe(400);
    const malformed = await app.request(REPLY_PATH, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
  });

  it("404s for a review that does not exist", async () => {
    const { putReply } = setup();
    const res = await putReply("Hello?");
    expect(res.status).toBe(404);
  });

  it("is hard-blocked on unverified locations, like real Google (#127's permanent failure)", async () => {
    const { store, putReply } = setup();
    store.addLocation({ verified: false });
    store.addReview(); // lands on the unverified location (last added)

    const res = await putReply(
      "This will not post.",
      "/v4/accounts/1/locations/2/reviews/1/reply",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: {
        code: 400,
        status: "FAILED_PRECONDITION",
        message:
          "This operation is only valid if the specified location is verified.",
      },
    });
  });
});

describe("reply moderation (store.setReplyState)", () => {
  it("REJECTED replies expose policyViolation and bump the review's updateTime", async () => {
    const { store, putReply, listReviews } = setup();
    const review = store.addReview();
    await putReply("We're sorry — call us at the front desk.");
    const afterReply = store.getReview(review.name)?.updateTime;
    if (!afterReply) throw new Error("expected review to exist");

    store.setReplyState(
      review.name,
      "REJECTED",
      "Reply removed for policy violation: contains personal information.",
    );

    const listed = (await listReviews()).reviews?.[0];
    expect(listed?.reviewReply?.reviewReplyState).toBe("REJECTED");
    expect(listed?.reviewReply?.policyViolation).toBe(
      "Reply removed for policy violation: contains personal information.",
    );
    // The poller notices moderation outcomes via updateTime (#123 → #127).
    expect(listed?.updateTime.localeCompare(afterReply)).toBeGreaterThan(0);
  });

  it("APPROVED clears any policyViolation", async () => {
    const { store, putReply, listReviews } = setup();
    const review = store.addReview();
    await putReply("Thanks!");
    store.setReplyState(review.name, "REJECTED", "Some reason.");
    store.setReplyState(review.name, "APPROVED");

    const reply = (await listReviews()).reviews?.[0]?.reviewReply;
    expect(reply?.reviewReplyState).toBe("APPROVED");
    expect(reply?.policyViolation).toBeUndefined();
  });

  it("throws when there is no reply to moderate", () => {
    const { store } = setup();
    const review = store.addReview();
    expect(() => store.setReplyState(review.name, "APPROVED")).toThrow(
      /no reply/,
    );
  });
});

describe("DELETE /v4/.../reviews/{r}/reply", () => {
  it("removes the reply; deleting a missing reply 404s", async () => {
    const { app, store, token, putReply, listReviews } = setup();
    store.addReview();
    await putReply("Short-lived.");

    const del = () =>
      app.request(REPLY_PATH, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    const first = await del();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({});
    expect((await listReviews()).reviews?.[0]?.reviewReply).toBeUndefined();
    expect((await del()).status).toBe(404);
  });
});
