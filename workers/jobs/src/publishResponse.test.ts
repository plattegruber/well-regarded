/**
 * Unit tests for the publish-response consumer (issue #82), end-to-end
 * through the REAL `publishReply` capability against the in-process fake
 * GBP server (#130) — no network, recorded sleeps — with an in-memory
 * store. The same flow against real Postgres lives in
 * test/publishResponse.integration.test.ts.
 *
 * Covered: success (accepted → `published` + moderation state), the
 * in-call 5xx retry (500×2 then 200), the queue-level transient budget
 * (retry with growing delay, then `failed` on the final delivery), dead
 * grant → auth-class failure with no retries burned, 404 → failed +
 * availability flip + no retry, synchronous moderation REJECTED →
 * needs-human failure, and the idempotency/stale-status guards.
 */

import { createLogger, type PublishResponseMessage } from "@wellregarded/core";
import type {
  ResponseReviewContext,
  ReviewResponse,
  TransitionResponseResult,
} from "@wellregarded/db";
import {
  createGoogleAccessTokenProvider,
  publishReply,
} from "@wellregarded/sources";
import { createFakeGbp, FakeGbpStore } from "@wellregarded/sources/google/fake";
import { describe, expect, it } from "vitest";

import {
  type FinalizePublishInput,
  handlePublishResponseMessage,
  type PublishConnectionRow,
  type PublishResponseDeps,
  type PublishResponseStore,
} from "./publishResponse";

const PRACTICE_ID = "8a9c1a52-6a54-4d43-9c39-9d5df2bb0e1a";
const RESPONSE_ID = "3f2b6a1e-90cd-4f5e-8a2f-1b0f4a7c9d21";
const SIGNAL_ID = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const AUTHOR_ID = "9b8a7c6d-5e4f-4a3b-8c1d-2e3f4a5b6c7d";

const MESSAGE: PublishResponseMessage = {
  responseId: RESPONSE_ID,
  practiceId: PRACTICE_ID,
  requestId: "req-test",
};

const LOG = createLogger({
  worker: "jobs",
  requestId: "req-test",
  level: "error",
  sink: () => {},
});

interface FakeWorld {
  deps: PublishResponseDeps;
  gbp: FakeGbpStore;
  reviewName: string;
  rows: { response: ReviewResponse };
  finalized: FinalizePublishInput[];
  attemptAudits: Array<{ action: string; payload: Record<string, unknown> }>;
  /** Recorded backoff sleeps inside publishReply (never waited). */
  sleeps: number[];
}

function makeResponse(overrides: Partial<ReviewResponse> = {}): ReviewResponse {
  return {
    id: RESPONSE_ID,
    practiceId: PRACTICE_ID,
    signalId: SIGNAL_ID,
    authorId: AUTHOR_ID,
    origin: "dashboard",
    status: "approved",
    body: "Thank you for the kind words!",
    rejectionComment: null,
    errorDetail: null,
    moderationState: null,
    policyViolation: null,
    publishedAt: null,
    publishUpdateTime: null,
    createdAt: new Date("2026-07-10T00:00:00Z"),
    updatedAt: new Date("2026-07-10T00:00:00Z"),
    ...overrides,
  };
}

function setup(
  overrides: {
    response?: Partial<ReviewResponse>;
    review?: Partial<ResponseReviewContext>;
    connection?: PublishConnectionRow | null;
    finalizeResult?: TransitionResponseResult;
  } = {},
): FakeWorld {
  const gbp = new FakeGbpStore();
  const { app } = createFakeGbp(gbp);
  gbp.addAccount();
  gbp.addLocation();
  const review = gbp.addReview();

  const doFetch: typeof fetch = async (input, init) =>
    app.fetch(new Request(input, init));

  const granted = gbp.exchangeAuthCode(gbp.issueAuthCode());
  if (!granted?.refreshToken) throw new Error("fake grant failed");
  const tokenProvider = createGoogleAccessTokenProvider({
    config: {
      tokenUrl: "http://fake-gbp.local/oauth/token",
      clientId: "client",
      clientSecret: "secret",
      fetch: doFetch,
    },
  });

  const responseRow = makeResponse(overrides.response);
  const reviewContext: ResponseReviewContext = {
    signalId: SIGNAL_ID,
    sourceKind: "google",
    sourceId: review.name,
    sourceUrl: "https://maps.example/review",
    availability: "available",
    visibility: "public",
    locationId: null,
    text: "Great cleaning!",
    rating: "5.0",
    sentiment: null,
    isNegative: false,
    ...overrides.review,
  };
  const connection: PublishConnectionRow | null =
    overrides.connection !== undefined
      ? overrides.connection
      : { id: "conn-1", status: "active", encryptedCredentials: "vault" };

  const rows = { response: responseRow };
  const finalized: FinalizePublishInput[] = [];
  const attemptAudits: Array<{
    action: string;
    payload: Record<string, unknown>;
  }> = [];
  const sleeps: number[] = [];

  const store: PublishResponseStore = {
    getResponse: async () => rows.response,
    getReviewContext: async () => reviewContext,
    getGoogleConnection: async () => connection,
    finalize: async (input) => {
      finalized.push(input);
      if (overrides.finalizeResult) return overrides.finalizeResult;
      rows.response = {
        ...rows.response,
        status: input.to,
        errorDetail:
          (input.patch.errorDetail as ReviewResponse["errorDetail"]) ?? null,
      };
      return { ok: true, response: rows.response };
    },
    auditAttempt: async (input) => {
      attemptAudits.push({ action: input.action, payload: input.payload });
    },
  };

  const deps: PublishResponseDeps = {
    store,
    // The REAL capability at the fake server — the seam the runtime wires.
    publish: (input) =>
      publishReply(
        {
          getAccessToken: () =>
            tokenProvider.getAccessToken({
              id: input.connection.id,
              refreshToken: granted.refreshToken ?? "",
            }),
          invalidateAccessToken: (id) => tokenProvider.invalidate(id),
          audit: input.audit,
          fetch: doFetch,
          baseUrl: "http://fake-gbp.local",
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          random: () => 0.5,
        },
        {
          connectionId: input.connection.id,
          reviewSourceId: input.reviewSourceId,
          text: input.text,
          actor: input.actor,
        },
      ),
    log: LOG,
    now: () => new Date("2026-07-11T12:00:00Z"),
  };

  return {
    deps,
    gbp,
    reviewName: review.name,
    rows,
    finalized,
    attemptAudits,
    sleeps,
  };
}

describe("publish-response consumer — success", () => {
  it("publishes the reply text to GBP and finalizes published (accepted, not live)", async () => {
    const w = setup();
    const outcome = await handlePublishResponseMessage(w.deps, MESSAGE, 1);

    expect(outcome).toEqual({ kind: "ack", result: "published" });
    // The fake actually received the reply text.
    expect(w.gbp.getReview(w.reviewName)?.reviewReply?.comment).toBe(
      "Thank you for the kind words!",
    );
    expect(w.finalized).toHaveLength(1);
    expect(w.finalized[0]).toMatchObject({
      to: "published",
      auditAction: "response.published",
      patch: {
        moderationState: "PENDING",
        publishedAt: new Date("2026-07-11T12:00:00Z"),
      },
    });
    expect(w.finalized[0]?.patch.publishUpdateTime).toBeTruthy();
    // The capability's audit detail rode into the same finalize call.
    expect(w.finalized[0]?.auditPayload).toMatchObject({ state: "PENDING" });
  });

  it("retries 5xx inside the call: 500 twice then 200 still publishes", async () => {
    const w = setup();
    w.gbp.failNext("PUT /v4/", { status: 500, times: 2 });

    const outcome = await handlePublishResponseMessage(w.deps, MESSAGE, 1);

    expect(outcome).toEqual({ kind: "ack", result: "published" });
    expect(w.sleeps).toHaveLength(2); // two in-call backoffs, recorded not waited
    expect(w.finalized[0]?.auditPayload).toMatchObject({ attempts: 3 });
  });
});

describe("publish-response consumer — transient failures and the queue budget", () => {
  it("re-queues with a growing delay while deliveries remain, auditing the attempt", async () => {
    const w = setup();
    w.gbp.failNext("PUT /v4/", { status: 500, times: 99 });

    const first = await handlePublishResponseMessage(w.deps, MESSAGE, 1);
    expect(first).toEqual({ kind: "retry", delaySeconds: 60 });
    // No transition — the row stays approved for the redelivery…
    expect(w.finalized).toHaveLength(0);
    expect(w.rows.response.status).toBe("approved");
    // …but the failed attempt is still audited (the #127 contract).
    expect(w.attemptAudits).toHaveLength(1);
    expect(w.attemptAudits[0]).toMatchObject({
      action: "response.publish_failed",
      payload: { deliveryAttempt: 1, willRetry: true },
    });

    const second = await handlePublishResponseMessage(w.deps, MESSAGE, 2);
    expect(second).toEqual({ kind: "retry", delaySeconds: 300 });
  });

  it("marks the row failed with transient_exhausted on the final delivery", async () => {
    const w = setup();
    w.gbp.failNext("PUT /v4/", { status: 500, times: 99 });

    const outcome = await handlePublishResponseMessage(w.deps, MESSAGE, 3);

    expect(outcome).toEqual({ kind: "ack", result: "failed" });
    expect(w.finalized[0]).toMatchObject({
      to: "failed",
      auditAction: "response.publish_failed",
      patch: {
        errorDetail: { kind: "transient_exhausted", lastStatus: 500 },
      },
    });
  });
});

describe("publish-response consumer — permanent and auth failures", () => {
  it("404 fails immediately, flips availability, and never retries", async () => {
    const w = setup();
    w.gbp.failNext("PUT /v4/", { status: 404, times: 99 });

    const outcome = await handlePublishResponseMessage(w.deps, MESSAGE, 1);

    expect(outcome).toEqual({ kind: "ack", result: "failed" });
    expect(w.finalized[0]).toMatchObject({
      to: "failed",
      markSignalDeletedAtSource: true,
      patch: {
        errorDetail: { kind: "permanent", reason: "review_not_found" },
      },
    });
    expect(w.sleeps).toHaveLength(0); // no backoff on permanent errors
  });

  it("skips the GBP call entirely when the review is already deleted at source", async () => {
    const w = setup({ review: { availability: "deleted_at_source" } });
    const outcome = await handlePublishResponseMessage(w.deps, MESSAGE, 1);

    expect(outcome).toEqual({ kind: "ack", result: "failed" });
    expect(w.gbp.getReview(w.reviewName)?.reviewReply).toBeUndefined();
    expect(w.finalized[0]?.patch.errorDetail).toMatchObject({
      kind: "permanent",
      reason: "review_not_found",
      message: "This review no longer exists on Google.",
    });
  });

  it("a dead refresh grant is an auth-class failure with no retries burned", async () => {
    const w = setup();
    w.gbp.failNext("POST /oauth/token", {
      status: 400,
      times: 99,
      body: { error: "invalid_grant" },
    });

    const outcome = await handlePublishResponseMessage(w.deps, MESSAGE, 1);

    expect(outcome).toEqual({ kind: "ack", result: "failed" });
    expect(w.finalized[0]?.patch.errorDetail).toMatchObject({
      kind: "needs_reauth",
    });
  });

  it("an inactive or credential-less connection fails as auth without a call", async () => {
    for (const connection of [
      null,
      { id: "conn-1", status: "needs_reauth", encryptedCredentials: "vault" },
      { id: "conn-1", status: "active", encryptedCredentials: null },
    ]) {
      const w = setup({ connection });
      const outcome = await handlePublishResponseMessage(w.deps, MESSAGE, 1);
      expect(outcome).toEqual({ kind: "ack", result: "failed" });
      expect(w.finalized[0]?.patch.errorDetail).toMatchObject({
        kind: "needs_reauth",
      });
      expect(w.gbp.getReview(w.reviewName)?.reviewReply).toBeUndefined();
    }
  });

  it("non-Google reviews fail permanently as unsupported", async () => {
    const w = setup({ review: { sourceKind: "csv", sourceId: null } });
    const outcome = await handlePublishResponseMessage(w.deps, MESSAGE, 1);
    expect(outcome).toEqual({ kind: "ack", result: "failed" });
    expect(w.finalized[0]?.patch.errorDetail).toMatchObject({
      kind: "permanent",
      reason: "unsupported_source",
    });
  });
});

describe("publish-response consumer — moderation REJECTED (synchronous)", () => {
  it("records a needs-human moderation_rejected failure, never a retry", async () => {
    const w = setup();
    // The fake's PUT always accepts as PENDING; the synchronous-REJECTED
    // shape is pinned by packages/sources' replies tests — here we inject
    // the capability result to exercise THIS layer's mapping.
    w.deps.publish = async (input) => {
      await input.audit({
        action: "response.publish_rejected",
        actor: input.actor,
        connectionId: input.connection.id,
        reviewSourceId: input.reviewSourceId,
        detail: { state: "REJECTED", policyViolation: "Off-topic content." },
        at: "2026-07-11T12:00:00.000Z",
      });
      return {
        published: false,
        state: "REJECTED",
        policyViolation: "Off-topic content.",
        attempts: 1,
      };
    };

    const outcome = await handlePublishResponseMessage(w.deps, MESSAGE, 1);

    expect(outcome).toEqual({ kind: "ack", result: "failed" });
    expect(w.finalized[0]).toMatchObject({
      to: "failed",
      auditAction: "response.publish_rejected",
      patch: {
        moderationState: "REJECTED",
        policyViolation: "Off-topic content.",
        errorDetail: {
          kind: "moderation_rejected",
          policyViolation: "Off-topic content.",
        },
      },
    });
  });
});

describe("publish-response consumer — idempotency and staleness", () => {
  it("skips already-published rows without calling GBP (redelivery safety)", async () => {
    const w = setup({ response: { status: "published" } });
    const outcome = await handlePublishResponseMessage(w.deps, MESSAGE, 1);
    expect(outcome).toEqual({ kind: "ack", result: "already_published" });
    expect(w.gbp.getReview(w.reviewName)?.reviewReply).toBeUndefined();
    expect(w.finalized).toHaveLength(0);
  });

  it("skips rows that are no longer approved (stale message)", async () => {
    for (const status of ["draft", "pending_approval", "failed"] as const) {
      const w = setup({ response: { status } });
      const outcome = await handlePublishResponseMessage(w.deps, MESSAGE, 1);
      expect(outcome).toEqual({ kind: "ack", result: "not_approved" });
      expect(w.finalized).toHaveLength(0);
    }
  });

  it("acks and audits when finalize loses a race", async () => {
    const w = setup({
      finalizeResult: {
        ok: false,
        code: "conflict",
        message: "Someone else acted on this response — reload and try again.",
      },
    });
    const outcome = await handlePublishResponseMessage(w.deps, MESSAGE, 1);
    expect(outcome).toEqual({ kind: "ack", result: "finalize_conflict" });
    // The Google outcome still landed in the audit trail.
    expect(w.attemptAudits).toHaveLength(1);
    expect(w.attemptAudits[0]?.payload).toMatchObject({
      finalizeConflict: "conflict",
    });
  });
});
