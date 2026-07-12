/**
 * Exhaustive tests for the responses state machine (issue #80): every legal
 * edge, every illegal pair in the full status × status grid, the structural
 * negative-review rules, the approve-time safety gate, and the issue-#82
 * publish contract helpers.
 */

import { describe, expect, it } from "vitest";

import {
  canTransition,
  describeResponseError,
  isPublishResponseQueue,
  PUBLISH_RESPONSE_MAX_DELIVERIES,
  publishResponseMessageSchema,
  publishResponseRetryDelaySeconds,
  RESPONSE_STATUSES,
  RESPONSE_TRANSITION_AUDIT_ACTIONS,
  type ResponseErrorDetail,
  type ResponseStatus,
  type ResponseTransitionContext,
  responseErrorClass,
} from "./response-state.js";

const AUTHOR = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";

/** A context that satisfies every human edge — tests subtract from it. */
function staffCtx(
  overrides: Partial<ResponseTransitionContext> = {},
): ResponseTransitionContext {
  return {
    actorId: OTHER,
    actorType: "staff",
    authorId: AUTHOR,
    permissions: { draftResponse: true, approveResponse: true },
    reviewIsNegative: false,
    safety: { level: "ok", warningsAcknowledged: false },
    rejectionComment: "Please soften the second sentence.",
    ...overrides,
  };
}

function systemCtx(): ResponseTransitionContext {
  return {
    actorId: "jobs:publish-response",
    actorType: "system",
    authorId: AUTHOR,
    permissions: { draftResponse: false, approveResponse: false },
    reviewIsNegative: false,
  };
}

const LEGAL_EDGES: ReadonlyArray<{
  from: ResponseStatus;
  to: ResponseStatus;
  ctx: () => ResponseTransitionContext;
}> = [
  { from: "draft", to: "pending_approval", ctx: staffCtx },
  { from: "pending_approval", to: "approved", ctx: staffCtx },
  { from: "pending_approval", to: "draft", ctx: staffCtx },
  { from: "approved", to: "published", ctx: systemCtx },
  { from: "approved", to: "failed", ctx: systemCtx },
  { from: "failed", to: "approved", ctx: staffCtx },
];

describe("canTransition — the full grid", () => {
  it("allows exactly the six documented edges and nothing else", () => {
    for (const from of RESPONSE_STATUSES) {
      for (const to of RESPONSE_STATUSES) {
        const legal = LEGAL_EDGES.find((e) => e.from === from && e.to === to);
        if (legal) {
          expect(
            canTransition(from, to, legal.ctx()),
            `${from} -> ${to} should be legal`,
          ).toMatchObject({ allowed: true });
        } else {
          // Even a maximally-privileged staff context AND a system context
          // are denied: the edge does not exist for anyone.
          for (const ctx of [staffCtx(), systemCtx()]) {
            expect(
              canTransition(from, to, ctx),
              `${from} -> ${to} should be illegal`,
            ).toMatchObject({ allowed: false, code: "invalid_transition" });
          }
        }
      }
    }
  });

  it("every legal edge carries its documented audit action", () => {
    for (const edge of LEGAL_EDGES) {
      const decision = canTransition(edge.from, edge.to, edge.ctx());
      expect(decision).toMatchObject({
        allowed: true,
        auditAction:
          RESPONSE_TRANSITION_AUDIT_ACTIONS[`${edge.from}->${edge.to}`],
      });
    }
  });

  it("there is no draft → published shortcut for anyone (structural gate)", () => {
    // The whole point of the machine: publication ALWAYS passes through
    // pending_approval + approved, no role exempted.
    expect(canTransition("draft", "published", staffCtx())).toMatchObject({
      allowed: false,
      code: "invalid_transition",
    });
    expect(canTransition("draft", "approved", staffCtx())).toMatchObject({
      allowed: false,
      code: "invalid_transition",
    });
  });
});

describe("draft → pending_approval (submit)", () => {
  it("requires the draft_response permission", () => {
    const ctx = staffCtx({
      permissions: { draftResponse: false, approveResponse: true },
    });
    expect(canTransition("draft", "pending_approval", ctx)).toMatchObject({
      allowed: false,
      code: "permission_denied",
    });
  });

  it("denies system actors", () => {
    expect(
      canTransition("draft", "pending_approval", systemCtx()),
    ).toMatchObject({ allowed: false, code: "staff_only" });
  });
});

describe("pending_approval → approved (approve)", () => {
  it("requires the approve_response permission", () => {
    const ctx = staffCtx({
      permissions: { draftResponse: true, approveResponse: false },
    });
    expect(canTransition("pending_approval", "approved", ctx)).toMatchObject({
      allowed: false,
      code: "permission_denied",
    });
  });

  it("blocks self-approval on negative reviews regardless of permissions", () => {
    const ctx = staffCtx({ actorId: AUTHOR, reviewIsNegative: true });
    expect(canTransition("pending_approval", "approved", ctx)).toMatchObject({
      allowed: false,
      code: "self_approval_negative",
    });
  });

  it("allows self-approval on non-negative reviews (the fast path)", () => {
    const ctx = staffCtx({ actorId: AUTHOR, reviewIsNegative: false });
    expect(canTransition("pending_approval", "approved", ctx)).toMatchObject({
      allowed: true,
    });
  });

  it("allows a non-author approver on negative reviews", () => {
    const ctx = staffCtx({ actorId: OTHER, reviewIsNegative: true });
    expect(canTransition("pending_approval", "approved", ctx)).toMatchObject({
      allowed: true,
    });
  });

  it("denies approval without a fresh safety verdict", () => {
    const ctx = staffCtx({ safety: undefined });
    expect(canTransition("pending_approval", "approved", ctx)).toMatchObject({
      allowed: false,
      code: "safety_missing",
    });
  });

  it("denies approval on a block-level safety verdict, even acknowledged", () => {
    const ctx = staffCtx({
      safety: { level: "block", warningsAcknowledged: true },
    });
    expect(canTransition("pending_approval", "approved", ctx)).toMatchObject({
      allowed: false,
      code: "safety_block",
    });
  });

  it("denies a warn-level verdict without the acknowledgment checkbox", () => {
    const ctx = staffCtx({
      safety: { level: "warn", warningsAcknowledged: false },
    });
    expect(canTransition("pending_approval", "approved", ctx)).toMatchObject({
      allowed: false,
      code: "safety_unacknowledged",
    });
  });

  it("allows a warn-level verdict once warnings are acknowledged", () => {
    const ctx = staffCtx({
      safety: { level: "warn", warningsAcknowledged: true },
    });
    expect(canTransition("pending_approval", "approved", ctx)).toMatchObject({
      allowed: true,
    });
  });

  it("denies system actors — approval is a human act", () => {
    expect(
      canTransition("pending_approval", "approved", systemCtx()),
    ).toMatchObject({ allowed: false, code: "staff_only" });
  });
});

describe("pending_approval → draft (reject)", () => {
  it("requires the approve_response permission", () => {
    const ctx = staffCtx({
      permissions: { draftResponse: true, approveResponse: false },
    });
    expect(canTransition("pending_approval", "draft", ctx)).toMatchObject({
      allowed: false,
      code: "permission_denied",
    });
  });

  it.each([
    undefined,
    "",
    "   ",
  ])("requires a non-blank comment (%j)", (rejectionComment) => {
    const ctx = staffCtx({ rejectionComment });
    expect(canTransition("pending_approval", "draft", ctx)).toMatchObject({
      allowed: false,
      code: "comment_required",
    });
  });
});

describe("publish outcome edges (approved → published | failed)", () => {
  it("are system-only — staff cannot record publish outcomes", () => {
    for (const to of ["published", "failed"] as const) {
      expect(canTransition("approved", to, staffCtx())).toMatchObject({
        allowed: false,
        code: "system_only",
      });
      expect(canTransition("approved", to, systemCtx())).toMatchObject({
        allowed: true,
      });
    }
  });
});

describe("failed → approved (manual retry)", () => {
  it("requires the approve_response permission", () => {
    const ctx = staffCtx({
      permissions: { draftResponse: true, approveResponse: false },
    });
    expect(canTransition("failed", "approved", ctx)).toMatchObject({
      allowed: false,
      code: "permission_denied",
    });
  });

  it("denies system actors — retry is a human decision", () => {
    expect(canTransition("failed", "approved", systemCtx())).toMatchObject({
      allowed: false,
      code: "staff_only",
    });
  });
});

// The negative-review predicate lives in ./reviews.ts (shared with #76's
// inbox ordering) and is tested in reviews.test.ts. Here we only pin that
// the structural gate consumes its verdict (the self-approval tests above)
// and that a null author (source-imported rows, #214) never trips it.
describe("null author (source-imported rows, #214)", () => {
  it("never trips the self-approval rule", () => {
    const ctx = staffCtx({
      actorId: OTHER,
      authorId: null,
      reviewIsNegative: true,
    });
    expect(canTransition("pending_approval", "approved", ctx)).toMatchObject({
      allowed: true,
    });
  });
});

describe("publish contract helpers (issue #82)", () => {
  it("classifies error details into surfacing classes", () => {
    const at = "2026-07-11T00:00:00.000Z";
    expect(responseErrorClass({ kind: "needs_reauth", at })).toBe("auth");
    expect(
      responseErrorClass({ kind: "transient_exhausted", message: "503", at }),
    ).toBe("transient");
    expect(
      responseErrorClass({ kind: "moderation_rejected", message: "no", at }),
    ).toBe("content");
    expect(
      responseErrorClass({
        kind: "permanent",
        reason: "review_not_found",
        message: "404",
        at,
      }),
    ).toBe("permanent");
  });

  it("describes every error kind in plain language", () => {
    const at = "2026-07-11T00:00:00.000Z";
    const details: ResponseErrorDetail[] = [
      { kind: "needs_reauth", at },
      { kind: "transient_exhausted", message: "HTTP 503", at },
      { kind: "moderation_rejected", policyViolation: "SPAM", message: "", at },
      { kind: "moderation_rejected", message: "", at },
      { kind: "permanent", reason: "review_not_found", message: "404", at },
      { kind: "permanent", reason: "location_unverified", message: "400", at },
      { kind: "permanent", reason: "invalid_argument", message: "400", at },
    ];
    for (const detail of details) {
      expect(describeResponseError(detail)).not.toBe("");
    }
    expect(
      describeResponseError({
        kind: "permanent",
        reason: "review_not_found",
        message: "404",
        at,
      }),
    ).toContain("no longer exists");
  });

  it("recognizes the publish queue name across environments", () => {
    expect(isPublishResponseQueue("wr-publish-response")).toBe(true);
    expect(isPublishResponseQueue("wr-publish-response-preview")).toBe(true);
    expect(isPublishResponseQueue("wr-publish-response-prod")).toBe(true);
    expect(isPublishResponseQueue("wr-publish-response-dlq")).toBe(false);
    expect(isPublishResponseQueue("wr-ingest")).toBe(false);
  });

  it("validates publish messages and rejects malformed ones", () => {
    const good = publishResponseMessageSchema.safeParse({
      responseId: "00000000-0000-4000-8000-000000000001",
      practiceId: "00000000-0000-4000-8000-000000000002",
      requestId: "req-1",
    });
    expect(good.success).toBe(true);
    expect(
      publishResponseMessageSchema.safeParse({ responseId: "nope" }).success,
    ).toBe(false);
  });

  it("retry delays grow and then plateau within the delivery budget", () => {
    expect(publishResponseRetryDelaySeconds(1)).toBe(60);
    expect(publishResponseRetryDelaySeconds(2)).toBe(300);
    expect(
      publishResponseRetryDelaySeconds(PUBLISH_RESPONSE_MAX_DELIVERIES),
    ).toBe(300);
  });
});
