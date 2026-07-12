/**
 * Integration tests for the `responses` table and `transitionResponse`
 * (issues #80/#82, migration 0020) against a real Postgres on the #49
 * harness: the full approval flow writes rows + audit entries atomically,
 * the guarded UPDATE turns races into conflicts, the negative-review
 * predicate reads rating-then-sentiment, and the publish-outcome patches
 * persist per the #127 seam contract.
 *
 *   docker compose up -d && pnpm --filter @wellregarded/db test:integration
 */

import type { Actor, ResponseErrorDetail } from "@wellregarded/core";
import { and, desc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  derivation,
  response,
  signal,
  staffMember,
} from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import { auditLog } from "../schema/audit.js";
import { responses } from "../schema/responses.js";
import {
  countPendingApprovals,
  createResponseDraft,
  getResponseReviewContext,
  listFailedPublishes,
  listResponsesForSignal,
  listResponsesPendingApproval,
  transitionResponse,
  updateResponseDraftBody,
  upsertImportedResponse,
} from "./responses.js";

const ALL_PERMISSIONS = { draftResponse: true, approveResponse: true };
const SAFETY_OK = { level: "ok" as const, warningsAcknowledged: false };

describe("responses (integration)", () => {
  const t = setupTestDb();
  let practiceId: string;
  let authorId: string;
  let approverId: string;
  let authorActor: Actor;
  let approverActor: Actor;

  beforeAll(async () => {
    const author = await staffMember(t.db);
    practiceId = author.practiceId;
    authorId = author.id;
    authorActor = { type: "staff", id: authorId };
    approverId = (await staffMember(t.db, { practiceId })).id;
    approverActor = { type: "staff", id: approverId };
  });

  function reviewSignal(overrides: Parameters<typeof signal>[1] = {}) {
    return signal(t.db, {
      practiceId,
      sourceKind: "google",
      visibility: "public",
      originalText: "Great cleaning, friendly staff.",
      originalRating: "5.0",
      ...overrides,
    });
  }

  async function latestAudit(entityId: string) {
    const [row] = await t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "responses"),
          eq(auditLog.entityId, entityId),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    return row;
  }

  it("createResponseDraft writes the row and its audit entry together", async () => {
    const s = await reviewSignal();
    const draft = await createResponseDraft(t.db, {
      practiceId,
      signalId: s.id,
      authorId,
      body: "Thank you for the kind words!",
      actor: authorActor,
    });
    expect(draft.status).toBe("draft");

    const entry = await latestAudit(draft.id);
    expect(entry).toMatchObject({
      action: "response.drafted",
      actorType: "staff",
      actorId: authorId,
      practiceId,
    });
  });

  it("updateResponseDraftBody edits drafts only, audited; non-drafts refuse", async () => {
    const s = await reviewSignal();
    const draft = await createResponseDraft(t.db, {
      practiceId,
      signalId: s.id,
      authorId,
      body: "First pass.",
      actor: authorActor,
    });

    // The composer's save path: body changes, audit row lands with it.
    const saved = await updateResponseDraftBody(t.db, {
      practiceId,
      responseId: draft.id,
      body: "Second pass — thank you for the feedback.",
      actor: authorActor,
    });
    expect(saved?.body).toBe("Second pass — thank you for the feedback.");
    expect(await latestAudit(draft.id)).toMatchObject({
      action: "response.draft_saved",
      payload: { signalId: s.id },
    });

    // Autosave twice: two audit rows, still ONE response row (no dupes).
    await updateResponseDraftBody(t.db, {
      practiceId,
      responseId: draft.id,
      body: "Third pass.",
      actor: authorActor,
    });
    const rows = await listResponsesForSignal(t.db, practiceId, s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe("Third pass.");

    // Once submitted, the body belongs to the workflow — the guarded
    // UPDATE refuses and the text stays put.
    await transitionResponse(t.db, {
      practiceId,
      responseId: draft.id,
      to: "pending_approval",
      actor: authorActor,
      staff: { staffId: authorId, permissions: ALL_PERMISSIONS },
    });
    const refused = await updateResponseDraftBody(t.db, {
      practiceId,
      responseId: draft.id,
      body: "Sneaky post-submit edit.",
      actor: authorActor,
    });
    expect(refused).toBeUndefined();
    const after = await listResponsesForSignal(t.db, practiceId, s.id);
    expect(after[0]?.body).toBe("Third pass.");
  });

  it("walks the happy path draft → pending_approval → approved with audits", async () => {
    const s = await reviewSignal();
    const draft = await response(t.db, {
      practiceId,
      signalId: s.id,
      authorId,
    });

    const submitted = await transitionResponse(t.db, {
      practiceId,
      responseId: draft.id,
      to: "pending_approval",
      actor: authorActor,
      staff: { staffId: authorId, permissions: ALL_PERMISSIONS },
    });
    expect(submitted).toMatchObject({ ok: true });
    expect(await latestAudit(draft.id)).toMatchObject({
      action: "response.submitted",
      payload: { from: "draft", to: "pending_approval", signalId: s.id },
    });

    const approved = await transitionResponse(t.db, {
      practiceId,
      responseId: draft.id,
      to: "approved",
      actor: approverActor,
      staff: { staffId: approverId, permissions: ALL_PERMISSIONS },
      safety: { level: "warn", warningsAcknowledged: true },
    });
    expect(approved).toMatchObject({ ok: true });
    expect(await latestAudit(draft.id)).toMatchObject({
      action: "response.approved",
      actorId: approverId,
      payload: {
        from: "pending_approval",
        to: "approved",
        safetyLevel: "warn",
        warningsAcknowledged: true,
      },
    });
  });

  it("rejects an illegal transition without touching the row", async () => {
    const draft = await response(t.db, {
      practiceId,
      signalId: (await reviewSignal()).id,
      authorId,
    });
    const result = await transitionResponse(t.db, {
      practiceId,
      responseId: draft.id,
      to: "published",
      actor: { type: "system", id: "jobs:publish-response" },
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_transition" });

    const rows = await listResponsesForSignal(t.db, practiceId, draft.signalId);
    expect(rows[0]?.status).toBe("draft");
    // No audit row was written for the refused transition.
    expect(await latestAudit(draft.id)).toBeUndefined();
  });

  it("blocks self-approval on a rating-negative review (structural rule)", async () => {
    const s = await reviewSignal({ originalRating: "1.0" });
    const pending = await response(t.db, {
      practiceId,
      signalId: s.id,
      authorId,
      status: "pending_approval",
    });

    const selfApprove = await transitionResponse(t.db, {
      practiceId,
      responseId: pending.id,
      to: "approved",
      actor: authorActor,
      staff: { staffId: authorId, permissions: ALL_PERMISSIONS },
      safety: SAFETY_OK,
    });
    expect(selfApprove).toMatchObject({
      ok: false,
      code: "self_approval_negative",
    });

    const otherApprove = await transitionResponse(t.db, {
      practiceId,
      responseId: pending.id,
      to: "approved",
      actor: approverActor,
      staff: { staffId: approverId, permissions: ALL_PERMISSIONS },
      safety: SAFETY_OK,
    });
    expect(otherApprove).toMatchObject({ ok: true });
  });

  it("uses the sentiment derivation for rating-less reviews", async () => {
    const s = await reviewSignal({
      sourceKind: "manual",
      originalRating: null,
    });
    await derivation(t.db, {
      signalId: s.id,
      practiceId,
      dimension: "sentiment",
      value: "negative",
    });

    const context = await getResponseReviewContext(t.db, practiceId, s.id);
    expect(context).toMatchObject({ isNegative: true, sentiment: "negative" });

    const pending = await response(t.db, {
      practiceId,
      signalId: s.id,
      authorId,
      status: "pending_approval",
    });
    const selfApprove = await transitionResponse(t.db, {
      practiceId,
      responseId: pending.id,
      to: "approved",
      actor: authorActor,
      staff: { staffId: authorId, permissions: ALL_PERMISSIONS },
      safety: SAFETY_OK,
    });
    expect(selfApprove).toMatchObject({
      ok: false,
      code: "self_approval_negative",
    });
  });

  it("reject requires a comment, stores it, and resubmission clears it", async () => {
    const pending = await response(t.db, {
      practiceId,
      signalId: (await reviewSignal()).id,
      authorId,
      status: "pending_approval",
    });

    const noComment = await transitionResponse(t.db, {
      practiceId,
      responseId: pending.id,
      to: "draft",
      actor: approverActor,
      staff: { staffId: approverId, permissions: ALL_PERMISSIONS },
    });
    expect(noComment).toMatchObject({ ok: false, code: "comment_required" });

    const rejected = await transitionResponse(t.db, {
      practiceId,
      responseId: pending.id,
      to: "draft",
      actor: approverActor,
      staff: { staffId: approverId, permissions: ALL_PERMISSIONS },
      comment: "Please remove the second sentence.",
    });
    expect(rejected).toMatchObject({ ok: true });
    if (rejected.ok) {
      expect(rejected.response.rejectionComment).toBe(
        "Please remove the second sentence.",
      );
    }
    expect(await latestAudit(pending.id)).toMatchObject({
      action: "response.rejected",
      payload: { comment: "Please remove the second sentence." },
    });

    const resubmitted = await transitionResponse(t.db, {
      practiceId,
      responseId: pending.id,
      to: "pending_approval",
      actor: authorActor,
      staff: { staffId: authorId, permissions: ALL_PERMISSIONS },
    });
    expect(resubmitted).toMatchObject({ ok: true });
    if (resubmitted.ok) {
      expect(resubmitted.response.rejectionComment).toBeNull();
    }
  });

  it("turns a lost race into a conflict via the guarded UPDATE", async () => {
    const pending = await response(t.db, {
      practiceId,
      signalId: (await reviewSignal()).id,
      authorId,
      status: "pending_approval",
    });

    // Simulate approve-vs-reject racing: the first write wins…
    const approve = await transitionResponse(t.db, {
      practiceId,
      responseId: pending.id,
      to: "approved",
      actor: approverActor,
      staff: { staffId: approverId, permissions: ALL_PERMISSIONS },
      safety: SAFETY_OK,
    });
    expect(approve).toMatchObject({ ok: true });

    // …and the loser (still holding the stale pending_approval read) gets
    // an invalid_transition/conflict, never a second write.
    const reject = await transitionResponse(t.db, {
      practiceId,
      responseId: pending.id,
      to: "draft",
      actor: approverActor,
      staff: { staffId: approverId, permissions: ALL_PERMISSIONS },
      comment: "Too late.",
    });
    expect(reject).toMatchObject({ ok: false, code: "invalid_transition" });
  });

  it("persists publish success per the #127 contract (accepted, not live)", async () => {
    const s = await reviewSignal();
    const approved = await response(t.db, {
      practiceId,
      signalId: s.id,
      authorId,
      status: "approved",
    });
    const publishedAt = new Date("2026-07-11T12:00:00Z");

    const result = await transitionResponse(t.db, {
      practiceId,
      responseId: approved.id,
      to: "published",
      actor: { type: "system", id: "jobs:publish-response" },
      patch: {
        publishedAt,
        publishUpdateTime: "2026-07-11T12:00:01.000Z",
        moderationState: "PENDING",
      },
      auditAction: "response.published",
      auditPayload: { state: "PENDING", attempts: 1 },
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.response.status).toBe("published");
      expect(result.response.publishedAt).toEqual(publishedAt);
      expect(result.response.moderationState).toBe("PENDING");
    }
    expect(await latestAudit(approved.id)).toMatchObject({
      action: "response.published",
      actorType: "system",
      payload: { state: "PENDING", attempts: 1, to: "published" },
    });
  });

  it("persists failures with error_detail, and manual retry clears them", async () => {
    const approved = await response(t.db, {
      practiceId,
      signalId: (await reviewSignal()).id,
      authorId,
      status: "approved",
    });
    const errorDetail: ResponseErrorDetail = {
      kind: "transient_exhausted",
      lastStatus: 503,
      message: "HTTP 503",
      at: "2026-07-11T12:00:00.000Z",
    };

    const failed = await transitionResponse(t.db, {
      practiceId,
      responseId: approved.id,
      to: "failed",
      actor: { type: "system", id: "jobs:publish-response" },
      patch: { errorDetail },
      auditAction: "response.publish_failed",
      auditPayload: { error: errorDetail, attempts: 3 },
    });
    expect(failed).toMatchObject({ ok: true });
    if (failed.ok) expect(failed.response.errorDetail).toEqual(errorDetail);

    const failures = await listFailedPublishes(t.db, { practiceId });
    expect(failures.items.some((f) => f.responseId === approved.id)).toBe(true);
    expect(failures.total).toBeGreaterThan(0);

    // Manual retry (issue #82 req 5): failed → approved via the machine,
    // permission-gated, clears the stored failure.
    const retried = await transitionResponse(t.db, {
      practiceId,
      responseId: approved.id,
      to: "approved",
      actor: approverActor,
      staff: { staffId: approverId, permissions: ALL_PERMISSIONS },
    });
    expect(retried).toMatchObject({ ok: true });
    if (retried.ok) {
      expect(retried.response.errorDetail).toBeNull();
      expect(retried.response.status).toBe("approved");
    }
    expect(await latestAudit(approved.id)).toMatchObject({
      action: "response.retry_requested",
    });
    expect(
      (await listFailedPublishes(t.db, { practiceId })).items.some(
        (f) => f.responseId === approved.id,
      ),
    ).toBe(false);
  });

  it("flips the signal's availability on review_not_found in the same call", async () => {
    const s = await reviewSignal();
    const approved = await response(t.db, {
      practiceId,
      signalId: s.id,
      authorId,
      status: "approved",
    });

    const result = await transitionResponse(t.db, {
      practiceId,
      responseId: approved.id,
      to: "failed",
      actor: { type: "system", id: "jobs:publish-response" },
      patch: {
        errorDetail: {
          kind: "permanent",
          reason: "review_not_found",
          status: 404,
          message: "Review not found.",
          at: "2026-07-11T12:00:00.000Z",
        },
      },
      auditAction: "response.publish_failed",
      markSignalDeletedAtSource: true,
    });
    expect(result).toMatchObject({ ok: true });

    const context = await getResponseReviewContext(t.db, practiceId, s.id);
    expect(context?.availability).toBe("deleted_at_source");
  });

  it("rolls back the status write when the audit insert fails (atomicity)", async () => {
    const pending = await response(t.db, {
      practiceId,
      signalId: (await reviewSignal()).id,
      authorId,
      status: "pending_approval",
    });

    // BigInt is not JSON-serializable — the audit payload write throws
    // inside the transaction, after the status UPDATE has run.
    await expect(
      transitionResponse(t.db, {
        practiceId,
        responseId: pending.id,
        to: "approved",
        actor: approverActor,
        staff: { staffId: approverId, permissions: ALL_PERMISSIONS },
        safety: SAFETY_OK,
        auditPayload: { unserializable: 1n as unknown as number },
      }),
    ).rejects.toThrow();

    const rows = await listResponsesForSignal(
      t.db,
      practiceId,
      pending.signalId,
    );
    expect(rows[0]?.status).toBe("pending_approval");
  });

  it("scopes reads and counts to the practice", async () => {
    const pending = await response(t.db, {
      practiceId,
      signalId: (await reviewSignal()).id,
      authorId,
      status: "pending_approval",
    });
    expect(await countPendingApprovals(t.db, practiceId)).toBeGreaterThan(0);

    const stranger = await staffMember(t.db); // new practice
    expect(await countPendingApprovals(t.db, stranger.practiceId)).toBe(0);

    const crossPractice = await transitionResponse(t.db, {
      practiceId: stranger.practiceId,
      responseId: pending.id,
      to: "approved",
      actor: { type: "staff", id: stranger.id },
      staff: { staffId: stranger.id, permissions: ALL_PERMISSIONS },
      safety: SAFETY_OK,
    });
    expect(crossPractice).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("listResponsesPendingApproval (Today section 6)", () => {
  const t2 = setupTestDb();

  it("lists pending rows oldest first, excluding the viewer's own drafts", async () => {
    const author = await staffMember(t2.db);
    const viewer = await staffMember(t2.db, { practiceId: author.practiceId });
    const s1 = await signal(t2.db, {
      practiceId: author.practiceId,
      sourceKind: "google",
      visibility: "public",
      sourceId: "accounts/1/locations/1/reviews/pa-1",
    });

    const older = await response(t2.db, {
      practiceId: author.practiceId,
      signalId: s1.id,
      authorId: author.id,
      status: "pending_approval",
      updatedAt: new Date("2026-07-01T00:00:00Z"),
    });
    const newer = await response(t2.db, {
      practiceId: author.practiceId,
      signalId: s1.id,
      authorId: author.id,
      status: "pending_approval",
      updatedAt: new Date("2026-07-05T00:00:00Z"),
    });
    // The viewer's own pending draft — excluded from THEIR queue.
    await response(t2.db, {
      practiceId: author.practiceId,
      signalId: s1.id,
      authorId: viewer.id,
      status: "pending_approval",
      updatedAt: new Date("2026-06-01T00:00:00Z"),
    });
    // A draft that is not pending — never a card.
    await response(t2.db, {
      practiceId: author.practiceId,
      signalId: s1.id,
      authorId: author.id,
      status: "draft",
    });

    const section = await listResponsesPendingApproval(t2.db, {
      practiceId: author.practiceId,
      excludeAuthorId: viewer.id,
    });
    expect(section.items.map((i) => i.responseId)).toEqual([
      older.id,
      newer.id,
    ]);
    expect(section.total).toBe(2);
    expect(section.items[0]?.authorName).toBe(author.displayName);

    // The cap keeps the section honest: 1 shown, total still 2.
    const capped = await listResponsesPendingApproval(t2.db, {
      practiceId: author.practiceId,
      excludeAuthorId: viewer.id,
      limit: 1,
    });
    expect(capped.items).toHaveLength(1);
    expect(capped.total).toBe(2);
  });
});

describe("upsertImportedResponse (#214)", () => {
  const t3 = setupTestDb();
  const importActor: Actor = { type: "system", id: "pipeline:normalize" };

  async function importedRows(signalId: string) {
    return t3.db
      .select()
      .from(responses)
      .where(
        and(
          eq(responses.signalId, signalId),
          eq(responses.origin, "source_import"),
        ),
      );
  }

  async function auditsFor(entityId: string) {
    return t3.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "responses"),
          eq(auditLog.entityId, entityId),
        ),
      )
      .orderBy(desc(auditLog.createdAt));
  }

  function replyInput(practiceId: string, signalId: string) {
    return {
      practiceId,
      signalId,
      body: "Thanks for the kind words — see you in six months!",
      publishedAt: new Date("2026-06-12T05:35:36.000Z"),
      publishUpdateTime: "2026-06-12T05:35:36.000Z",
      moderationState: "APPROVED" as const,
      policyViolation: null,
      actor: importActor,
      auditPayload: { importRunId: "run-1" },
    };
  }

  it("creates the imported row born published, authorless, moderation carried, audited as system", async () => {
    const s = await signal(t3.db, {
      sourceKind: "google",
      visibility: "public",
      sourceId: "accounts/1/locations/1/reviews/imp-1",
      originalRating: "5.0",
    });

    const result = await t3.db.transaction((tx) =>
      upsertImportedResponse(tx, replyInput(s.practiceId, s.id)),
    );
    expect(result.outcome).toBe("created");
    expect(result.response).toMatchObject({
      origin: "source_import",
      status: "published",
      authorId: null,
      body: "Thanks for the kind words — see you in six months!",
      moderationState: "APPROVED",
      policyViolation: null,
      publishUpdateTime: "2026-06-12T05:35:36.000Z",
    });
    expect(result.response?.publishedAt?.toISOString()).toBe(
      "2026-06-12T05:35:36.000Z",
    );

    const audits = await auditsFor(result.response?.id ?? "");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "response.imported",
      actorType: "system",
      actorId: "pipeline:normalize",
      practiceId: s.practiceId,
    });
    expect(audits[0]?.payload).toMatchObject({
      signalId: s.id,
      origin: "source_import",
      moderationState: "APPROVED",
      importRunId: "run-1",
    });
  });

  it("is idempotent: a byte-identical re-poll writes nothing and audits nothing", async () => {
    const s = await signal(t3.db, {
      sourceKind: "google",
      visibility: "public",
      sourceId: "accounts/1/locations/1/reviews/imp-2",
      originalRating: "4.0",
    });
    const input = replyInput(s.practiceId, s.id);

    const first = await t3.db.transaction((tx) =>
      upsertImportedResponse(tx, input),
    );
    const second = await t3.db.transaction((tx) =>
      upsertImportedResponse(tx, input),
    );
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("unchanged");
    expect(second.response?.id).toBe(first.response?.id);

    expect(await importedRows(s.id)).toHaveLength(1);
    expect(await auditsFor(first.response?.id ?? "")).toHaveLength(1);
  });

  it("an edited reply (or a moderation flip) updates the imported row in place, audited", async () => {
    const s = await signal(t3.db, {
      sourceKind: "google",
      visibility: "public",
      sourceId: "accounts/1/locations/1/reviews/imp-3",
      originalRating: "2.0",
    });
    const created = await t3.db.transaction((tx) =>
      upsertImportedResponse(tx, {
        ...replyInput(s.practiceId, s.id),
        moderationState: "PENDING",
      }),
    );

    // Google moderated the reply and the owner rewrote it.
    const updated = await t3.db.transaction((tx) =>
      upsertImportedResponse(tx, {
        ...replyInput(s.practiceId, s.id),
        body: "We are sorry about the wait — please call us to make it right.",
        publishedAt: new Date("2026-07-01T00:00:00.000Z"),
        publishUpdateTime: "2026-07-01T00:00:00.000Z",
        moderationState: "REJECTED",
        policyViolation: "Contains personal information.",
      }),
    );
    expect(updated.outcome).toBe("updated");
    // In place: same row id, no second imported row, content tracked.
    expect(updated.response?.id).toBe(created.response?.id);
    expect(await importedRows(s.id)).toHaveLength(1);
    expect(updated.response).toMatchObject({
      status: "published",
      body: "We are sorry about the wait — please call us to make it right.",
      moderationState: "REJECTED",
      policyViolation: "Contains personal information.",
      publishUpdateTime: "2026-07-01T00:00:00.000Z",
    });

    const audits = await auditsFor(created.response?.id ?? "");
    expect(audits.map((a) => a.action)).toEqual([
      "response.import_updated",
      "response.imported",
    ]);
    expect(audits[0]?.payload).toMatchObject({
      moderationState: "REJECTED",
      policyViolation: "Contains personal information.",
    });
  });

  it("coexists with dashboard-origin rows: only its own source_import row is ever touched", async () => {
    const author = await staffMember(t3.db);
    const s = await signal(t3.db, {
      practiceId: author.practiceId,
      sourceKind: "google",
      visibility: "public",
      sourceId: "accounts/1/locations/1/reviews/imp-4",
      originalRating: "3.0",
    });
    const draft = await response(t3.db, {
      practiceId: author.practiceId,
      signalId: s.id,
      authorId: author.id,
      status: "draft",
      body: "A staff draft in progress.",
    });

    const imported = await t3.db.transaction((tx) =>
      upsertImportedResponse(tx, replyInput(author.practiceId, s.id)),
    );
    expect(imported.outcome).toBe("created");
    const again = await t3.db.transaction((tx) =>
      upsertImportedResponse(tx, {
        ...replyInput(author.practiceId, s.id),
        body: "Edited at the source.",
      }),
    );
    expect(again.outcome).toBe("updated");

    // The dashboard draft is untouched; the signal has exactly one
    // imported row (the partial unique index makes more impossible).
    const all = await t3.db
      .select()
      .from(responses)
      .where(eq(responses.signalId, s.id));
    expect(all).toHaveLength(2);
    const draftRow = all.find((r) => r.id === draft.id);
    expect(draftRow).toMatchObject({
      origin: "dashboard",
      status: "draft",
      body: "A staff draft in progress.",
    });
    expect(await importedRows(s.id)).toHaveLength(1);
  });
});
