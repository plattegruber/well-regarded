/**
 * Tests for `publishReply` / `deleteReply` (issue #127): the moderation-aware
 * success path, the transient/permanent failure matrix, needs_reauth
 * propagation, local byte-cap validation, and the one-audit-event-per-call
 * guarantee. All HTTP goes to the in-process fake GBP server (#130) via
 * injected fetch — no network, and backoff sleeps are recorded, not waited.
 */

import type { Actor } from "@wellregarded/core";
import { describe, expect, it } from "vitest";
import { createGoogleAccessTokenProvider, NeedsReauthError } from "./auth.js";
import { createFakeGbp } from "./fake/index.js";
import { FakeGbpStore } from "./fake/store.js";
import {
  deleteReply,
  GBP_REPLY_MAX_ATTEMPTS,
  GBP_REPLY_MAX_BYTES,
  type GbpReplyDeps,
  PermanentReplyError,
  publishReply,
  type ReplyAuditEvent,
  replyByteLength,
  replyErrorDetail,
  TransientReplyError,
} from "./replies.js";

const STAFF: Actor = { type: "staff", id: "staff-1" };
const TOKEN_URL = "http://fake-gbp.local/oauth/token";

function setup(store = new FakeGbpStore()) {
  const { app } = createFakeGbp(store);
  store.addAccount();
  store.addLocation();

  /** Paths hit through the injected fetch, `"METHOD /path"`. */
  const calls: string[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
    return app.fetch(request);
  };
  const v4Calls = () => calls.filter((c) => c.includes("/v4/"));

  const granted = store.exchangeAuthCode(store.issueAuthCode());
  if (!granted?.refreshToken) throw new Error("expected refresh token");
  const connection = { id: "conn-1", refreshToken: granted.refreshToken };
  const provider = createGoogleAccessTokenProvider({
    config: {
      tokenUrl: TOKEN_URL,
      clientId: "client",
      clientSecret: "secret",
      fetch: doFetch,
    },
  });

  const auditEvents: ReplyAuditEvent[] = [];
  const sleeps: number[] = [];
  const deps: GbpReplyDeps = {
    getAccessToken: () => provider.getAccessToken(connection),
    invalidateAccessToken: (id) => provider.invalidate(id),
    audit: async (event) => {
      auditEvents.push(event);
    },
    fetch: doFetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5, // deterministic jitter: base × 1.0
  };

  const publish = (text: string, reviewSourceId: string) =>
    publishReply(deps, {
      connectionId: connection.id,
      reviewSourceId,
      text,
      actor: STAFF,
    });

  return {
    store,
    deps,
    connection,
    publish,
    calls,
    v4Calls,
    sleeps,
    auditEvents,
  };
}

describe("publishReply — success & moderation", () => {
  it("publishes: PENDING state, updateTime, reply visible at the fake, one audit event", async () => {
    const { store, publish, auditEvents, sleeps } = setup();
    const review = store.addReview();

    const result = await publish("Thank you for the kind words!", review.name);

    expect(result).toMatchObject({
      published: true,
      state: "PENDING",
      attempts: 1,
    });
    expect(result.updateTime).toBeDefined();
    expect(result.policyViolation).toBeUndefined();
    expect(store.getReview(review.name)?.reviewReply?.comment).toBe(
      "Thank you for the kind words!",
    );
    expect(sleeps).toEqual([]);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "response.published",
      actor: STAFF,
      connectionId: "conn-1",
      reviewSourceId: review.name,
      detail: { state: "PENDING", attempts: 1 },
    });
  });

  it("carries a synchronous APPROVED verdict through", async () => {
    const { store, publish } = setup(
      new FakeGbpStore({ initialReplyState: "APPROVED" }),
    );
    const review = store.addReview();
    const result = await publish("Thanks!", review.name);
    expect(result).toMatchObject({ published: true, state: "APPROVED" });
  });

  it("reports a REJECTED verdict as published: false with policyViolation surfaced", async () => {
    const { store, publish, auditEvents } = setup();
    const review = store.addReview();
    // The fake's upsert always starts PENDING; script the moderation verdict
    // Google would return on the PUT itself.
    store.failNext("PUT /v4/", {
      status: 200,
      body: {
        comment: "We're sorry — call us.",
        updateTime: "2026-07-10T00:00:00Z",
        reviewReplyState: "REJECTED",
        policyViolation:
          "Reply removed for policy violation: contains personal information.",
      },
    });

    const result = await publish("We're sorry — call us.", review.name);

    expect(result).toMatchObject({
      published: false,
      state: "REJECTED",
      policyViolation:
        "Reply removed for policy violation: contains personal information.",
      attempts: 1,
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.action).toBe("response.publish_rejected");
    expect(auditEvents[0]?.detail).toMatchObject({
      state: "REJECTED",
      policyViolation:
        "Reply removed for policy violation: contains personal information.",
    });
  });

  it("round-trips moderation: PENDING → APPROVED (poller's view) → re-publish resets to PENDING", async () => {
    const { store, publish } = setup();
    const review = store.addReview();

    await publish("First wording.", review.name);
    // Google approves asynchronously — the #123 poller notices via the
    // bumped updateTime; #127 itself never polls.
    const beforeApproval = store.getReview(review.name)?.updateTime;
    store.setReplyState(review.name, "APPROVED");
    const approved = store.getReview(review.name);
    expect(approved?.reviewReply?.reviewReplyState).toBe("APPROVED");
    expect(
      beforeApproval && approved?.updateTime.localeCompare(beforeApproval),
    ).toBeGreaterThan(0);

    // The PUT is an upsert: re-publishing replaces the reply and moderation
    // starts over.
    const second = await publish("Final wording.", review.name);
    expect(second).toMatchObject({ published: true, state: "PENDING" });
    expect(store.getReview(review.name)?.reviewReply?.comment).toBe(
      "Final wording.",
    );
  });

  it("round-trips a REJECTED verdict with policyViolation through the store", async () => {
    const { store, publish } = setup();
    const review = store.addReview();
    await publish("Borderline wording.", review.name);

    store.setReplyState(review.name, "REJECTED", "Off-topic content.");
    const reply = store.getReview(review.name)?.reviewReply;
    expect(reply?.reviewReplyState).toBe("REJECTED");
    expect(reply?.policyViolation).toBe("Off-topic content.");
  });
});

describe("publishReply — local validation (no HTTP)", () => {
  it("rejects oversize replies on UTF-8 BYTE length before any call", async () => {
    const { store, publish, calls, auditEvents } = setup();
    const review = store.addReview();
    // 1025 four-byte emoji: 1025 chars, 4100 bytes — over the cap while
    // comfortably under 4096 characters.
    const emoji = "💚".repeat(1025);
    expect(replyByteLength(emoji)).toBeGreaterThan(GBP_REPLY_MAX_BYTES);

    const failure = await publish(emoji, review.name).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(PermanentReplyError);
    expect(failure).toMatchObject({
      reason: "reply_too_long",
      retryable: false,
      message: expect.stringContaining("4100 UTF-8 bytes"),
    });
    expect(calls).toEqual([]); // not even a token fetch
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "response.publish_failed",
      detail: {
        error: { kind: "permanent", reason: "reply_too_long" },
        attempts: 0,
      },
    });
  });

  it("allows exactly 4096 bytes", async () => {
    const { store, publish } = setup();
    const review = store.addReview();
    const result = await publish("a".repeat(GBP_REPLY_MAX_BYTES), review.name);
    expect(result.published).toBe(true);
  });

  it("rejects empty text and malformed review resource names locally", async () => {
    const { store, publish, calls } = setup();
    const review = store.addReview();
    await expect(publish("", review.name)).rejects.toMatchObject({
      name: "PermanentReplyError",
      reason: "empty_reply",
    });
    await expect(publish("Hi!", "locations/1/reviews/1")).rejects.toMatchObject(
      {
        name: "PermanentReplyError",
        reason: "invalid_review_name",
      },
    );
    expect(calls).toEqual([]);
  });
});

describe("publishReply — transient failures retry with backoff", () => {
  it("recovers from 429×2 (honoring Retry-After) and publishes on attempt 3", async () => {
    const { store, publish, v4Calls, sleeps, auditEvents } = setup();
    const review = store.addReview();
    store.failNext("PUT /v4/", { status: 429, times: 2 });

    const result = await publish("Third time lucky.", review.name);

    expect(result).toMatchObject({
      published: true,
      state: "PENDING",
      attempts: 3,
    });
    expect(v4Calls()).toHaveLength(3);
    expect(sleeps).toEqual([1000, 1000]); // fake's Retry-After: 1
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "response.published",
      detail: { attempts: 3 },
    });
  });

  it("recovers from a 500 with jittered exponential backoff", async () => {
    const { store, publish, sleeps } = setup();
    const review = store.addReview();
    store.failNext("PUT /v4/", { status: 500 });

    const result = await publish("Once more.", review.name);
    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([2000]); // 2s base × (0.5 + 0.5) deterministic jitter
  });

  it("recovers from a thrown network error", async () => {
    const { store, deps, connection } = setup();
    const review = store.addReview();
    const realFetch = deps.fetch;
    if (!realFetch) throw new Error("expected injected fetch");
    let failures = 1;
    deps.fetch = async (input, init) => {
      if (failures > 0 && new Request(input, init).url.includes("/v4/")) {
        failures -= 1;
        throw new TypeError("fetch failed");
      }
      return realFetch(input, init);
    };

    const result = await publishReply(deps, {
      connectionId: connection.id,
      reviewSourceId: review.name,
      text: "Through the flaky network.",
      actor: STAFF,
    });
    expect(result).toMatchObject({ published: true, attempts: 2 });
  });

  it("exhausts after 3 attempts of persistent 500s → retryable TransientReplyError", async () => {
    const { store, publish, v4Calls, sleeps, auditEvents } = setup();
    const review = store.addReview();
    store.failNext("PUT /v4/", { status: 500, times: 5 });

    const failure = await publish("Never lands.", review.name).catch(
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(TransientReplyError);
    expect(failure).toMatchObject({
      retryable: true,
      attempts: GBP_REPLY_MAX_ATTEMPTS,
      lastStatus: 500,
    });
    expect(v4Calls()).toHaveLength(3);
    expect(sleeps).toEqual([2000, 8000]); // bounded: never approaches the 60s budget
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "response.publish_failed",
      detail: {
        error: { kind: "transient_exhausted", lastStatus: 500 },
        attempts: 3,
      },
    });
  });

  it("retries a 401 once the stale cached token is invalidated", async () => {
    const { store, publish, v4Calls } = setup();
    const review = store.addReview();
    // Prime the provider's cache, then kill every outstanding access token:
    // the next PUT presents a stale bearer and 401s.
    await publish("Prime the token cache.", review.name);
    store.expireAccessTokens();

    const result = await publish("Fresh token on retry.", review.name);
    expect(result).toMatchObject({ published: true, attempts: 2 });
    expect(v4Calls()).toHaveLength(3); // 1 primer + 401 + retried success
  });
});

describe("publishReply — permanent failures never retry", () => {
  it("400 INVALID_ARGUMENT → permanent, exactly one call, no sleeps", async () => {
    const { store, publish, v4Calls, sleeps, auditEvents } = setup();
    const review = store.addReview();
    store.failNext("PUT /v4/", { status: 400 });

    const failure = await publish("Rejected.", review.name).catch(
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(PermanentReplyError);
    expect(failure).toMatchObject({
      reason: "invalid_argument",
      retryable: false,
      google: { status: 400, googleStatus: "INVALID_ARGUMENT" },
    });
    expect(v4Calls()).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(auditEvents[0]?.detail).toMatchObject({
      error: { kind: "permanent", reason: "invalid_argument", status: 400 },
    });
  });

  it("403 → permission_denied, not retried", async () => {
    const { store, publish, v4Calls } = setup();
    const review = store.addReview();
    store.failNext("PUT /v4/", { status: 403 });
    await expect(publish("No access.", review.name)).rejects.toMatchObject({
      name: "PermanentReplyError",
      reason: "permission_denied",
    });
    expect(v4Calls()).toHaveLength(1);
  });

  it("unverified location → the distinct location_unverified classification (FAILED_PRECONDITION)", async () => {
    const { store, publish } = setup();
    store.addLocation({ verified: false });
    const review = store.addReview(); // lands on the unverified location

    const failure = await publish("Will not post.", review.name).catch(
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(PermanentReplyError);
    expect(failure).toMatchObject({
      reason: "location_unverified",
      google: { status: 400, googleStatus: "FAILED_PRECONDITION" },
      message: expect.stringContaining("unverified"),
    });
  });

  it("404 (review deleted at source) → review_not_found for the availability flip", async () => {
    const { store, publish, auditEvents } = setup();
    const review = store.addReview();
    store.deleteReview(review.name);

    await expect(publish("Too late.", review.name)).rejects.toMatchObject({
      name: "PermanentReplyError",
      reason: "review_not_found",
      google: { status: 404 },
    });
    expect(auditEvents[0]?.detail).toMatchObject({
      error: { kind: "permanent", reason: "review_not_found", status: 404 },
    });
  });
});

describe("publishReply — needs_reauth", () => {
  it("propagates NeedsReauthError without retrying, with a needs_reauth audit entry", async () => {
    const { store, publish, connection, v4Calls, auditEvents } = setup();
    const review = store.addReview();
    store.revokeRefreshToken(connection.refreshToken);

    const failure = await publish("Dead grant.", review.name).catch(
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(NeedsReauthError);
    expect(v4Calls()).toEqual([]); // never reached the reply endpoint
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "response.publish_failed",
      detail: { error: { kind: "needs_reauth" } },
    });
  });
});

describe("deleteReply", () => {
  it("removes the owner reply, with its own audit action", async () => {
    const { store, deps, connection, publish, auditEvents } = setup();
    const review = store.addReview();
    await publish("Short-lived.", review.name);

    const result = await deleteReply(deps, {
      connectionId: connection.id,
      reviewSourceId: review.name,
      actor: STAFF,
    });

    expect(result).toEqual({ deleted: true, attempts: 1 });
    expect(store.getReview(review.name)?.reviewReply).toBeUndefined();
    expect(auditEvents.at(-1)).toMatchObject({
      action: "response.reply_deleted",
      reviewSourceId: review.name,
    });
  });

  it("404 with no reply → permanent reply_not_found", async () => {
    const { store, deps, connection, auditEvents } = setup();
    const review = store.addReview();

    await expect(
      deleteReply(deps, {
        connectionId: connection.id,
        reviewSourceId: review.name,
        actor: STAFF,
      }),
    ).rejects.toMatchObject({
      name: "PermanentReplyError",
      reason: "reply_not_found",
    });
    expect(auditEvents.at(-1)?.action).toBe("response.reply_delete_failed");
  });

  it("retries transient failures like publish does", async () => {
    const { store, deps, connection, publish, sleeps } = setup();
    const review = store.addReview();
    await publish("Delete me, eventually.", review.name);
    store.failNext("DELETE /v4/", { status: 503 });

    const result = await deleteReply(deps, {
      connectionId: connection.id,
      reviewSourceId: review.name,
      actor: STAFF,
    });
    expect(result).toEqual({ deleted: true, attempts: 2 });
    expect(sleeps).toEqual([2000]);
  });
});

describe("replyErrorDetail — the Epic #10 error_detail contract", () => {
  const AT = "2026-07-10T12:00:00.000Z";

  it("renders each error family to its documented shape", () => {
    expect(
      replyErrorDetail(new TransientReplyError("boom", 3, 503), AT),
    ).toEqual({
      kind: "transient_exhausted",
      lastStatus: 503,
      message: "boom",
      at: AT,
    });

    expect(
      replyErrorDetail(new TransientReplyError("net down", 3), AT),
    ).toEqual({ kind: "transient_exhausted", message: "net down", at: AT });

    expect(
      replyErrorDetail(
        new PermanentReplyError("location_unverified", "blocked", {
          status: 400,
          googleStatus: "FAILED_PRECONDITION",
        }),
        AT,
      ),
    ).toEqual({
      kind: "permanent",
      reason: "location_unverified",
      status: 400,
      googleStatus: "FAILED_PRECONDITION",
      message: "blocked",
      at: AT,
    });

    expect(replyErrorDetail(new NeedsReauthError("conn-1"), AT)).toEqual({
      kind: "needs_reauth",
      at: AT,
    });
  });

  it("returns undefined for errors this module did not produce", () => {
    expect(replyErrorDetail(new Error("bug"), AT)).toBeUndefined();
    expect(replyErrorDetail("not even an error", AT)).toBeUndefined();
  });
});
