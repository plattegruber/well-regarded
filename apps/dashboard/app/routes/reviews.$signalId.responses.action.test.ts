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

import { textHash } from "~/lib/safety-spans";

const getResponse = vi.hoisted(() => vi.fn());
const getResponseReviewContext = vi.hoisted(() => vi.fn());
const listResponsesForSignal = vi.hoisted(() => vi.fn());
const transitionResponse = vi.hoisted(() => vi.fn());
const createResponseDraft = vi.hoisted(() => vi.fn());
const updateResponseDraftBody = vi.hoisted(() => vi.fn());
const requirePracticeContext = vi.hoisted(() => vi.fn());
const aiProvider = vi.hoisted(
  () => ({ current: undefined as unknown }) as { current: unknown },
);

vi.mock("@wellregarded/db", () => ({
  getResponse,
  getResponseReviewContext,
  listResponsesForSignal,
  transitionResponse,
  createResponseDraft,
  updateResponseDraftBody,
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

// ---------------------------------------------------------------------------
// Composer intents (#79)
// ---------------------------------------------------------------------------

describe("draft-with-ai", () => {
  it("returns a Sonnet-lane draft plus its safety verdict in one round trip", async () => {
    const provider = new FakeAiProvider({
      "response-draft/v1": [
        { draft: "Thank you for the kind words — comfort matters to us." },
      ],
      "safety/v1": [{ findings: [] }],
    });
    aiProvider.current = provider;

    const result = await action(actionArgs({ intent: "draft-with-ai" }));
    expect(result).toMatchObject({
      data: {
        draft: "Thank you for the kind words — comfort matters to us.",
        safety: { level: "ok" },
      },
    });
    // The staleness contract: the hash is of exactly the drafted text.
    const payload = (
      result as unknown as {
        data: { draft: string; safety: { checkedHash: string } };
      }
    ).data;
    expect(payload.safety.checkedHash).toBe(textHash(payload.draft));

    // Drafting rides the drafting lane with the response_draft purpose;
    // the safety re-check rides the pipeline lane (#72).
    expect(provider.calls[0]).toMatchObject({
      model: "fake-drafting",
      opts: { purpose: "response_draft", practiceId: PRACTICE_ID },
    });
    expect(provider.calls[1]).toMatchObject({
      model: "fake-pipeline",
      opts: { purpose: "safety" },
    });
    // The prompt sees the review text, rating, and practice name — and the
    // fixture key is the constant prompt name.
    expect(provider.calls[0]?.prompt.name).toBe("response-draft/v1");
    expect(provider.calls[0]?.prompt.user).toContain("Great cleaning!");
    expect(provider.calls[0]?.prompt.user).toContain("5.0 out of 5");
  });

  it("surfaces AI unavailability as a friendly message, never a 500", async () => {
    const { AiRequestError } = await import("@wellregarded/ai");
    aiProvider.current = {
      classify: () =>
        Promise.reject(new AiRequestError("budget exceeded", { attempts: 1 })),
    };
    const result = await action(actionArgs({ intent: "draft-with-ai" }));
    expect(result).toMatchObject({
      data: {
        aiUnavailable: "AI drafting is paused — you can still write a reply.",
      },
    });
  });

  it("403s for roles without draft_response", async () => {
    requirePracticeContext.mockResolvedValue(practiceContext("provider"));
    await expect(
      action(actionArgs({ intent: "draft-with-ai" })),
    ).rejects.toMatchObject({ init: { status: 403 } });
  });
});

describe("safety-check", () => {
  it("merges deterministic and fake-LLM findings, spans intact, hash echoed", async () => {
    const body = "So sorry about your visit on March 3rd.";
    aiProvider.current = new FakeAiProvider({
      "safety/v1": [
        {
          findings: [
            {
              category: "confirms_care_relationship",
              quote: "your visit",
              reason: "Confirms the reviewer was seen at the practice.",
              suggestion: "Address the feedback without referencing a visit.",
            },
          ],
        },
      ],
    });

    const result = await action(actionArgs({ intent: "safety-check", body }));
    const payload = (
      result as {
        data: {
          safety: {
            level: string;
            checkedHash: string;
            findings: Array<{
              code: string;
              span: { start: number; end: number } | null;
            }>;
          };
        };
      }
    ).data;

    expect(payload.safety.level).toBe("block");
    expect(payload.safety.checkedHash).toBe(textHash(body));
    const codes = payload.safety.findings.map((finding) => finding.code);
    // Deterministic date + care-context findings AND the model's finding.
    expect(codes).toContain("appointment_detail");
    expect(codes).toContain("confirms_care_relationship");
    for (const finding of payload.safety.findings) {
      if (!finding.span) continue;
      expect(finding.span.start).toBeGreaterThanOrEqual(0);
      expect(finding.span.end).toBeLessThanOrEqual(body.length);
    }
  });

  it("degraded mode returns deterministic findings plus the honest notice", async () => {
    const { AiRequestError } = await import("@wellregarded/ai");
    aiProvider.current = {
      classify: () =>
        Promise.reject(new AiRequestError("no key", { attempts: 0 })),
    };
    const result = await action(
      actionArgs({ intent: "safety-check", body: "Sorry about March 3rd." }),
    );
    const payload = (
      result as {
        data: { safety: { level: string; findings: Array<{ code: string }> } };
      }
    ).data;
    expect(payload.safety.level).toBe("block");
    expect(payload.safety.findings.map((finding) => finding.code)).toContain(
      "ai_check_skipped",
    );
  });
});

describe("save-draft", () => {
  it("creates a draft row on first save and echoes the id for adoption", async () => {
    createResponseDraft.mockResolvedValue(
      responseRow({ status: "draft", body: "A first draft." }),
    );
    const result = await action(
      actionArgs({ intent: "save-draft", body: "A first draft." }),
    );
    expect(result).toMatchObject({
      data: { saved: { responseId: RESPONSE_ID, body: "A first draft." } },
    });
    expect(createResponseDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        signalId: SIGNAL_ID,
        authorId: STAFF_ID,
        body: "A first draft.",
      }),
    );
  });

  it("updates an existing draft without creating a duplicate", async () => {
    getResponse.mockResolvedValue(responseRow({ status: "draft" }));
    updateResponseDraftBody.mockResolvedValue(
      responseRow({ status: "draft", body: "Edited." }),
    );
    const result = await action(
      actionArgs({
        intent: "save-draft",
        responseId: RESPONSE_ID,
        body: "Edited.",
      }),
    );
    expect(result).toMatchObject({
      data: { saved: { responseId: RESPONSE_ID, body: "Edited." } },
    });
    expect(createResponseDraft).not.toHaveBeenCalled();
  });

  it("409s when the row is no longer a draft", async () => {
    getResponse.mockResolvedValue(responseRow({ status: "pending_approval" }));
    updateResponseDraftBody.mockResolvedValue(undefined);
    const result = await action(
      actionArgs({
        intent: "save-draft",
        responseId: RESPONSE_ID,
        body: "Too late.",
      }),
    );
    expect(result).toMatchObject({ init: { status: 409 } });
  });

  it("422s an empty body and a body over the GBP byte cap", async () => {
    const empty = await action(
      actionArgs({ intent: "save-draft", body: "  " }),
    );
    expect(empty).toMatchObject({ init: { status: 422 } });

    const oversized = await action(
      actionArgs({ intent: "save-draft", body: "€".repeat(1400) }), // 4200 bytes
    );
    expect(oversized).toMatchObject({ init: { status: 422 } });
    expect(createResponseDraft).not.toHaveBeenCalled();
  });
});

describe("submit-for-approval — the compose-side safety gate (#79 req 5)", () => {
  it("rejects a block finding server-side; the disabled button is not the enforcement", async () => {
    const body = "Sorry about your root canal on March 3rd.";
    getResponse.mockResolvedValue(responseRow({ status: "draft" }));
    updateResponseDraftBody.mockResolvedValue(
      responseRow({ status: "draft", body }),
    );
    const result = await action(
      actionArgs({
        intent: "submit-for-approval",
        responseId: RESPONSE_ID,
        body,
      }),
    );
    expect(result).toMatchObject({
      init: { status: 422 },
      data: { safety: { level: "block" } },
    });
    expect(transitionResponse).not.toHaveBeenCalled();
  });

  it("warn demands the acknowledgment; acknowledged submits with the verdict audited", async () => {
    const body = "Please call us at (555) 201-4400.";
    aiProvider.current = new FakeAiProvider({
      "safety/v1": [{ findings: [] }, { findings: [] }],
    });
    getResponse.mockResolvedValue(responseRow({ status: "draft", body }));

    const bounced = await action(
      actionArgs({
        intent: "submit-for-approval",
        responseId: RESPONSE_ID,
        body,
      }),
    );
    expect(bounced).toMatchObject({
      init: { status: 422 },
      data: { safety: { level: "warn" } },
    });
    expect(transitionResponse).not.toHaveBeenCalled();

    const acknowledged = await action(
      actionArgs({
        intent: "submit-for-approval",
        responseId: RESPONSE_ID,
        body,
        acknowledgeWarnings: "yes",
      }),
    );
    expect(acknowledged).toBeInstanceOf(Response);
    expect(transitionResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        to: "pending_approval",
        auditPayload: { safetyLevel: "warn", warningsAcknowledged: true },
      }),
    );
  });

  it("creates the draft row when the composer submits before any autosave", async () => {
    createResponseDraft.mockResolvedValue(
      responseRow({ status: "draft", body: "Thank you kindly." }),
    );
    const result = await action(
      actionArgs({ intent: "submit-for-approval", body: "Thank you kindly." }),
    );
    expect(result).toBeInstanceOf(Response);
    expect(createResponseDraft).toHaveBeenCalled();
    expect(transitionResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: "pending_approval" }),
    );
  });

  it("end-to-end: AI draft → edit introduces a date → block → fix → submit succeeds", async () => {
    const provider = new FakeAiProvider({
      "response-draft/v1": [
        { draft: "Thank you for the kind words — comfort matters to us." },
      ],
      // One safety call per step that runs the full check: the draft
      // action, the blocked submit, and the clean submit.
      "safety/v1": [{ findings: [] }, { findings: [] }, { findings: [] }],
    });
    aiProvider.current = provider;

    // 1. Draft with AI — an editable draft arrives with a clean verdict.
    const drafted = await action(actionArgs({ intent: "draft-with-ai" }));
    const draft = (
      drafted as unknown as {
        data: { draft: string; safety: { level: string } };
      }
    ).data;
    expect(draft.safety.level).toBe("ok");

    // 2. The human edit introduces a date; autosave persists it.
    const edited = `${draft.draft} Sorry again about March 3rd.`;
    createResponseDraft.mockResolvedValue(
      responseRow({ status: "draft", body: edited }),
    );
    const savedResult = await action(
      actionArgs({ intent: "save-draft", body: edited }),
    );
    expect(savedResult).toMatchObject({
      data: { saved: { responseId: RESPONSE_ID } },
    });

    // 3. Submit is refused: the deterministic date rule blocks server-side.
    getResponse.mockResolvedValue(
      responseRow({ status: "draft", body: edited }),
    );
    updateResponseDraftBody.mockResolvedValue(
      responseRow({ status: "draft", body: edited }),
    );
    const blocked = await action(
      actionArgs({
        intent: "submit-for-approval",
        responseId: RESPONSE_ID,
        body: edited,
      }),
    );
    expect(blocked).toMatchObject({
      init: { status: 422 },
      data: { safety: { level: "block" } },
    });
    expect(transitionResponse).not.toHaveBeenCalled();

    // 4. The date is edited away; submit-for-approval goes through.
    const fixed = draft.draft;
    updateResponseDraftBody.mockResolvedValue(
      responseRow({ status: "draft", body: fixed }),
    );
    const submitted = await action(
      actionArgs({
        intent: "submit-for-approval",
        responseId: RESPONSE_ID,
        body: fixed,
      }),
    );
    expect(submitted).toBeInstanceOf(Response);
    expect((submitted as Response).status).toBe(302);
    expect(transitionResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        to: "pending_approval",
        auditPayload: { safetyLevel: "ok", warningsAcknowledged: false },
      }),
    );
  });
});
