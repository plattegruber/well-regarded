/**
 * Publish-response integration tests (issue #82): the consumer with its
 * REAL store (`transitionResponse` + audit over real Postgres, packages/db
 * template-clone harness) driven end-to-end through the REAL `publishReply`
 * against the in-process fake GBP server (#130).
 *
 * Covered: approved response → consumer → fake GBP receives the reply text
 * → row `published` with `published_at` + updateTime + a single
 * system-actor audit row; 500×2 then 200 retries in-call and succeeds;
 * dead grant → `failed` auth class, connection flipped `needs_reauth`, no
 * redelivery requested; 404 → `failed` + the signal's availability flipped
 * `deleted_at_source`; final-delivery transient → `failed` with
 * `transient_exhausted`; manual-retry transition clears the failure so the
 * row is re-publishable.
 */

import {
  createLogger,
  encryptField,
  type PublishResponseMessage,
} from "@wellregarded/core";
import { schema } from "@wellregarded/db";
import {
  createGoogleAccessTokenProvider,
  publishReply,
} from "@wellregarded/sources";
import { createFakeGbp, type FakeGbp } from "@wellregarded/sources/google/fake";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  response,
  signal,
  sourceConnection,
  staffMember,
  TEST_KEYRING,
} from "../../../packages/db/test/factories.js";
import { setupTestDb } from "../../../packages/db/test/harness.js";
import { persistNeedsReauth } from "../src/gbpSyncStore";
import {
  handlePublishResponseMessage,
  type PublishResponseDeps,
} from "../src/publishResponse";
import { createPublishResponseStore } from "../src/publishResponseRuntime";

const { auditLog, responses, signals, sourceConnections } = schema;

const t = setupTestDb();

const LOG = createLogger({
  worker: "jobs",
  requestId: "req-integration",
  level: "error",
  sink: () => {},
});

interface Harness {
  fake: FakeGbp;
  deps: PublishResponseDeps;
  message: PublishResponseMessage;
  practiceId: string;
  connectionId: string;
  signalId: string;
  responseId: string;
  reviewName: string;
}

/** A practice with a Google connection, a google review signal, and an
 * approved response — the state #80's approve action leaves behind. */
async function harness(): Promise<Harness> {
  const fake = createFakeGbp();
  fake.store.addAccount();
  fake.store.addLocation();
  const review = fake.store.addReview();

  const granted = fake.store.exchangeAuthCode(fake.store.issueAuthCode());
  if (!granted?.refreshToken) throw new Error("fake grant failed");

  const author = await staffMember(t.db);
  const practiceId = author.practiceId;
  const connection = await sourceConnection(t.db, {
    practiceId,
    kind: "google",
    status: "active",
    encryptedCredentials: await encryptField(
      JSON.stringify({
        refreshToken: granted.refreshToken,
        obtainedAt: new Date().toISOString(),
      }),
      TEST_KEYRING,
    ),
  });
  const reviewSignal = await signal(t.db, {
    practiceId,
    sourceKind: "google",
    sourceId: review.name,
    visibility: "public",
    originalText: "Wonderful hygienist!",
    originalRating: "5.0",
  });
  const approved = await response(t.db, {
    practiceId,
    signalId: reviewSignal.id,
    authorId: author.id,
    status: "approved",
    body: "Thank you — comfort matters to us.",
  });

  const gbpFetch: typeof fetch = async (input, init) =>
    fake.app.fetch(new Request(input, init));
  const tokenProvider = createGoogleAccessTokenProvider({
    config: {
      tokenUrl: "http://fake-gbp.local/oauth/token",
      clientId: "client",
      clientSecret: "secret",
      fetch: gbpFetch,
    },
    // The REAL persistence hook the runtime wires.
    onInvalidGrant: (connectionId) => persistNeedsReauth(t.db, connectionId),
  });

  const deps: PublishResponseDeps = {
    store: createPublishResponseStore(t.db),
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
          fetch: gbpFetch,
          baseUrl: "http://fake-gbp.local",
          sleep: () => Promise.resolve(),
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
  };

  return {
    fake,
    deps,
    message: {
      responseId: approved.id,
      practiceId,
      requestId: "req-integration",
    },
    practiceId,
    connectionId: connection.id,
    signalId: reviewSignal.id,
    responseId: approved.id,
    reviewName: review.name,
  };
}

async function loadResponse(id: string) {
  const [row] = await t.db
    .select()
    .from(responses)
    .where(eq(responses.id, id))
    .limit(1);
  if (!row) throw new Error("response row missing");
  return row;
}

async function responseAudits(id: string) {
  return t.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "responses"), eq(auditLog.entityId, id)))
    .orderBy(asc(auditLog.createdAt));
}

describe("publish-response consumer (integration)", () => {
  it("publishes end to end: fake GBP gets the text, the row goes published, one audit row", async () => {
    const h = await harness();
    const outcome = await handlePublishResponseMessage(h.deps, h.message, 1);

    expect(outcome).toEqual({ kind: "ack", result: "published" });
    expect(h.fake.store.getReview(h.reviewName)?.reviewReply?.comment).toBe(
      "Thank you — comfort matters to us.",
    );

    const row = await loadResponse(h.responseId);
    expect(row.status).toBe("published");
    expect(row.publishedAt).not.toBeNull();
    expect(row.publishUpdateTime).toBeTruthy();
    expect(row.moderationState).toBe("PENDING"); // accepted, not live

    const audits = await responseAudits(h.responseId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "response.published",
      actorType: "system",
      actorId: "jobs:publish-response",
      practiceId: h.practiceId,
      payload: {
        from: "approved",
        to: "published",
        state: "PENDING",
        attempts: 1,
      },
    });

    // Redelivery after success is a no-op (idempotency guard).
    const redelivered = await handlePublishResponseMessage(
      h.deps,
      h.message,
      2,
    );
    expect(redelivered).toEqual({ kind: "ack", result: "already_published" });
    expect(await responseAudits(h.responseId)).toHaveLength(1);
  });

  it("retries in-call on 500×2 then succeeds, recording the attempts", async () => {
    const h = await harness();
    h.fake.store.failNext("PUT /v4/", { status: 500, times: 2 });

    const outcome = await handlePublishResponseMessage(h.deps, h.message, 1);

    expect(outcome).toEqual({ kind: "ack", result: "published" });
    const audits = await responseAudits(h.responseId);
    expect(audits[0]?.payload).toMatchObject({ attempts: 3 });
  });

  it("marks failed with transient_exhausted on the final delivery, audits every attempt", async () => {
    const h = await harness();
    // Exactly two full deliveries' worth of failures (3 in-call attempts
    // each) — the manual-retry republish at the end then succeeds.
    h.fake.store.failNext("PUT /v4/", { status: 503, times: 6 });

    const first = await handlePublishResponseMessage(h.deps, h.message, 1);
    expect(first).toEqual({ kind: "retry", delaySeconds: 60 });
    expect((await loadResponse(h.responseId)).status).toBe("approved");

    const final = await handlePublishResponseMessage(h.deps, h.message, 3);
    expect(final).toEqual({ kind: "ack", result: "failed" });

    const row = await loadResponse(h.responseId);
    expect(row.status).toBe("failed");
    expect(row.errorDetail).toMatchObject({
      kind: "transient_exhausted",
      lastStatus: 503,
    });

    // Two audit rows: the retried attempt and the finalizing failure.
    const audits = await responseAudits(h.responseId);
    expect(audits).toHaveLength(2);
    expect(audits[0]?.payload).toMatchObject({ willRetry: true });
    expect(audits[1]?.payload).toMatchObject({ to: "failed" });

    // Manual retry (the dashboard action's transition): failed → approved
    // clears the failure so the re-enqueued message can publish.
    const { transitionResponse } = await import("@wellregarded/db");
    const approver = await staffMember(t.db, { practiceId: h.practiceId });
    const retried = await transitionResponse(t.db, {
      practiceId: h.practiceId,
      responseId: h.responseId,
      to: "approved",
      actor: { type: "staff", id: approver.id },
      staff: {
        staffId: approver.id,
        permissions: { draftResponse: true, approveResponse: true },
      },
    });
    expect(retried).toMatchObject({ ok: true });

    const republished = await handlePublishResponseMessage(
      h.deps,
      h.message,
      1,
    );
    expect(republished).toEqual({ kind: "ack", result: "published" });
    expect((await loadResponse(h.responseId)).errorDetail).toBeNull();
  });

  it("a dead grant fails as auth, flips the connection, and asks no redelivery", async () => {
    const h = await harness();
    h.fake.store.failNext("POST /oauth/token", {
      status: 400,
      times: 99,
      body: { error: "invalid_grant" },
    });

    const outcome = await handlePublishResponseMessage(h.deps, h.message, 1);

    expect(outcome).toEqual({ kind: "ack", result: "failed" });
    const row = await loadResponse(h.responseId);
    expect(row.status).toBe("failed");
    expect(row.errorDetail).toMatchObject({ kind: "needs_reauth" });

    // #118's machinery (persistNeedsReauth) flipped the connection durably.
    const [connection] = await t.db
      .select()
      .from(sourceConnections)
      .where(eq(sourceConnections.id, h.connectionId))
      .limit(1);
    expect(connection?.status).toBe("needs_reauth");
  });

  it("404 fails with review-no-longer-exists AND flips the signal's availability", async () => {
    const h = await harness();
    h.fake.store.failNext("PUT /v4/", { status: 404, times: 99 });

    const outcome = await handlePublishResponseMessage(h.deps, h.message, 1);

    expect(outcome).toEqual({ kind: "ack", result: "failed" });
    const row = await loadResponse(h.responseId);
    expect(row.errorDetail).toMatchObject({
      kind: "permanent",
      reason: "review_not_found",
    });

    const [signalRow] = await t.db
      .select()
      .from(signals)
      .where(eq(signals.id, h.signalId))
      .limit(1);
    expect(signalRow?.availability).toBe("deleted_at_source");

    // A later redelivery short-circuits before any GBP call: the review is
    // known-deleted, and the row is already failed anyway.
    const redelivered = await handlePublishResponseMessage(
      h.deps,
      h.message,
      2,
    );
    expect(redelivered).toEqual({ kind: "ack", result: "not_approved" });
  });
});
