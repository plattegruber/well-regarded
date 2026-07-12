// Action-recipe tests for the response workflow route (#80/#82), node
// environment (actions are server code). The transition + audit writes
// are integration-tested in packages/db (transitionResponse) and the
// publish consumer in workers/jobs; here we assert the recipe around
// them: permission gates, parse-don't-throw, the FRESH safety gate at
// approve time (real `checkResponseSafety` with a FakeAiProvider — block
// stops approval, warn demands the checkbox, degraded mode still
// approves), denial → status mapping, and the enqueue-on-approve/retry.
import { FakeAiProvider } from "@wellregarded/ai";
import type { StaffActor } from "@wellregarded/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getResponse = vi.hoisted(() => vi.fn());
const getResponseReviewContext = vi.hoisted(() => vi.fn());
const listResponsesForSignal = vi.hoisted(() => vi.fn());
const transitionResponse = vi.hoisted(() => vi.fn());
const requirePracticeContext = vi.hoisted(() => vi.fn());
const aiProvider = vi.hoisted(
  () => ({ current: undefined as unknown }) as { current: unknown },
);

vi.mock("@wellregarded/db", () => ({
  getResponse,
  getResponseReviewContext,
  listResponsesForSignal,
  transitionResponse,
}));
vi.mock("~/lib/db.server", () => ({
  withRequestDb: (_context: unknown, fn: (db: unknown) => Promise<unknown>) =>
    fn({}),
}));
vi.mock("~/lib/practice-context.server", () => ({ requirePracticeContext }));
vi.mock("~/lib/ai.server", () => ({
  getAiProvider: () => aiProvider.current,
}));

import { action } from "./reviews.$signalId.responses";

const PRACTICE_ID = "0f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const SIGNAL_ID = "1f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const RESPONSE_ID = "2f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const STAFF_ID = "3f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const AUTHOR_ID = "4f9619ff-8b86-4d01-b42d-00cf4fc964ff";

function practiceContext(role: StaffActor["role"]) {
  const actor: StaffActor = {
    type: "staff",
    staffId: STAFF_ID,
    practiceId: PRACTICE_ID,
    role,
    locationId: null,
  };
  return {
    practiceId: PRACTICE_ID,
    actor,
    auditActor: { type: "staff" as const, id: STAFF_ID },
    viewer: { viewPrivateFeedback: true, viewPatientIdentity: true },
  };
}

function responseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RESPONSE_ID,
    practiceId: PRACTICE_ID,
    signalId: SIGNAL_ID,
    authorId: AUTHOR_ID,
    status: "pending_approval",
    body: "Thank you for the kind words.",
    ...overrides,
  };
}

function reviewContext(overrides: Record<string, unknown> = {}) {
  return {
    signalId: SIGNAL_ID,
    sourceKind: "google",
    sourceId: "accounts/1/locations/1/reviews/1",
    sourceUrl: "https://maps.example/r/1",
    availability: "available",
    visibility: "public",
    locationId: null,
    text: "Great cleaning!",
    rating: "5.0",
    sentiment: null,
    isNegative: false,
    ...overrides,
  };
}

const queueSend = vi.fn();

function actionArgs(fields: Record<string, string>, signalId = SIGNAL_ID) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    body.append(key, value);
  }
  const request = new Request(
    `http://localhost/reviews/${signalId}/responses`,
    { method: "POST", body },
  );
  return {
    request,
    params: { signalId },
    context: {
      cloudflare: {
        env: {
          ENVIRONMENT: "local",
          PUBLISH_RESPONSE_QUEUE: { send: queueSend },
        } as unknown as Env,
        ctx: {} as ExecutionContext,
      },
      requestId: "test-request-id",
      // biome-ignore lint/suspicious/noExplicitAny: the optional-chained logger is unused in these paths
      logger: undefined as any,
    },
    // biome-ignore lint/suspicious/noExplicitAny: route arg typing is generated per-route; the test erases it
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePracticeContext.mockResolvedValue(practiceContext("owner"));
  getResponse.mockResolvedValue(responseRow());
  getResponseReviewContext.mockResolvedValue(reviewContext());
  transitionResponse.mockResolvedValue({ ok: true, response: responseRow() });
  // Layer 2 finds nothing unless a test registers otherwise.
  aiProvider.current = new FakeAiProvider({ "safety/v1": [{ findings: [] }] });
});

describe("approve", () => {
  it("re-runs the safety check, transitions with the verdict, and enqueues", async () => {
    const result = await action(
      actionArgs({ intent: "approve", responseId: RESPONSE_ID }),
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);

    expect(transitionResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        to: "approved",
        responseId: RESPONSE_ID,
        safety: { level: "ok", warningsAcknowledged: false },
        staff: expect.objectContaining({
          staffId: STAFF_ID,
          permissions: { draftResponse: true, approveResponse: true },
        }),
      }),
    );
    expect(queueSend).toHaveBeenCalledWith({
      responseId: RESPONSE_ID,
      practiceId: PRACTICE_ID,
      requestId: "test-request-id",
    });
  });

  it("a block-level finding on the CURRENT text stops approval with 422", async () => {
    // Deterministic Layer 1 blocks on the date + procedure-with-"your" —
    // no model needed: the text changed since the composer's last check.
    getResponse.mockResolvedValue(
      responseRow({ body: "Sorry about your root canal on March 3rd." }),
    );
    const result = await action(
      actionArgs({ intent: "approve", responseId: RESPONSE_ID }),
    );
    expect(result).toMatchObject({
      init: { status: 422 },
      data: { safety: { level: "block" } },
    });
    expect(transitionResponse).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("warn requires the explicit acknowledgment checkbox", async () => {
    // A phone number is a deterministic warn (phi_identifier). Two calls
    // hit the fake (bounce, then acknowledged retry).
    aiProvider.current = new FakeAiProvider({
      "safety/v1": [{ findings: [] }, { findings: [] }],
    });
    getResponse.mockResolvedValue(
      responseRow({ body: "Please call us at (555) 201-4400." }),
    );

    const bounced = await action(
      actionArgs({ intent: "approve", responseId: RESPONSE_ID }),
    );
    expect(bounced).toMatchObject({
      init: { status: 422 },
      data: { safety: { level: "warn", needsAcknowledgement: true } },
    });
    expect(transitionResponse).not.toHaveBeenCalled();

    const acknowledged = await action(
      actionArgs({
        intent: "approve",
        responseId: RESPONSE_ID,
        acknowledgeWarnings: "yes",
      }),
    );
    expect(acknowledged).toBeInstanceOf(Response);
    expect(transitionResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        to: "approved",
        safety: { level: "warn", warningsAcknowledged: true },
      }),
    );
  });

  it("degraded AI mode still approves clean text (deterministic-only)", async () => {
    // No fixtures → FakeAiProvider throws; getAiProvider's degraded stub is
    // the prod equivalent. Use a provider that throws AiRequestError-shaped.
    const { AiRequestError } = await import("@wellregarded/ai");
    aiProvider.current = {
      classify: () =>
        Promise.reject(new AiRequestError("no key", { attempts: 0 })),
    };
    const result = await action(
      actionArgs({ intent: "approve", responseId: RESPONSE_ID }),
    );
    expect(result).toBeInstanceOf(Response);
    expect(transitionResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        safety: { level: "ok", warningsAcknowledged: false },
      }),
    );
  });

  it("maps a stale-status race to 409", async () => {
    transitionResponse.mockResolvedValue({
      ok: false,
      code: "conflict",
      message: "Someone else acted on this response — reload and try again.",
    });
    const result = await action(
      actionArgs({ intent: "approve", responseId: RESPONSE_ID }),
    );
    expect(result).toMatchObject({ init: { status: 409 } });
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("maps the structural self-approval denial to 403", async () => {
    transitionResponse.mockResolvedValue({
      ok: false,
      code: "self_approval_negative",
      message:
        "Responses to negative reviews must be approved by someone other than the author.",
    });
    const result = await action(
      actionArgs({ intent: "approve", responseId: RESPONSE_ID }),
    );
    expect(result).toMatchObject({ init: { status: 403 } });
  });

  it("403s outright for roles without approve_response", async () => {
    requirePracticeContext.mockResolvedValue(practiceContext("front_desk"));
    await expect(
      action(actionArgs({ intent: "approve", responseId: RESPONSE_ID })),
    ).rejects.toMatchObject({ init: { status: 403 } });
    expect(transitionResponse).not.toHaveBeenCalled();
  });
});

describe("reject", () => {
  it("400s without a comment — never a bare transition", async () => {
    const result = await action(
      actionArgs({ intent: "reject", responseId: RESPONSE_ID, comment: "  " }),
    );
    expect(result).toMatchObject({
      init: { status: 400 },
      data: { fieldErrors: { comment: ["A comment is required to reject."] } },
    });
    expect(transitionResponse).not.toHaveBeenCalled();
  });

  it("transitions back to draft with the comment", async () => {
    const result = await action(
      actionArgs({
        intent: "reject",
        responseId: RESPONSE_ID,
        comment: "Please soften the tone.",
      }),
    );
    expect(result).toBeInstanceOf(Response);
    expect(transitionResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        to: "draft",
        comment: "Please soften the tone.",
      }),
    );
  });
});

describe("submit-for-approval", () => {
  it("transitions draft → pending_approval and redirects", async () => {
    getResponse.mockResolvedValue(responseRow({ status: "draft" }));
    const result = await action(
      actionArgs({ intent: "submit-for-approval", responseId: RESPONSE_ID }),
    );
    expect(result).toBeInstanceOf(Response);
    expect(transitionResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: "pending_approval" }),
    );
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("403s for roles without draft_response", async () => {
    requirePracticeContext.mockResolvedValue(practiceContext("provider"));
    await expect(
      action(
        actionArgs({ intent: "submit-for-approval", responseId: RESPONSE_ID }),
      ),
    ).rejects.toMatchObject({ init: { status: 403 } });
  });
});

describe("retry-publish", () => {
  it("transitions failed → approved via the machine and re-enqueues", async () => {
    getResponse.mockResolvedValue(responseRow({ status: "failed" }));
    const result = await action(
      actionArgs({ intent: "retry-publish", responseId: RESPONSE_ID }),
    );
    expect(result).toBeInstanceOf(Response);
    expect(transitionResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: "approved" }),
    );
    expect(queueSend).toHaveBeenCalledWith({
      responseId: RESPONSE_ID,
      practiceId: PRACTICE_ID,
      requestId: "test-request-id",
    });
  });
});

describe("parsing and scoping", () => {
  it("422s malformed intents instead of throwing", async () => {
    const result = await action(
      actionArgs({ intent: "explode", responseId: RESPONSE_ID }),
    );
    expect(result).toMatchObject({ init: { status: 422 } });
  });

  it("404s when the response belongs to a different signal", async () => {
    getResponse.mockResolvedValue(
      responseRow({ signalId: "9f9619ff-8b86-4d01-b42d-00cf4fc964ff" }),
    );
    await expect(
      action(actionArgs({ intent: "approve", responseId: RESPONSE_ID })),
    ).rejects.toMatchObject({ init: { status: 404 } });
  });
});
