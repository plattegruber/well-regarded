// Action-recipe tests for Settings → Response templates (#83), node
// environment. The CRUD round-trip and audit rows are integration-tested
// in packages/db; here we assert the recipe around them: the
// manage_settings gate, the placeholder-whitelist linter, and the
// save-time safety gate (block rejects the save, warn demands the
// acknowledgment, clean bodies save) — with a real `checkResponseSafety`
// over a FakeAiProvider.
import { FakeAiProvider } from "@wellregarded/ai";
import type { StaffActor } from "@wellregarded/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listResponseTemplates = vi.hoisted(() => vi.fn());
const getResponseTemplate = vi.hoisted(() => vi.fn());
const createResponseTemplate = vi.hoisted(() => vi.fn());
const updateResponseTemplate = vi.hoisted(() => vi.fn());
const requirePracticeContext = vi.hoisted(() => vi.fn());
const aiProvider = vi.hoisted(
  () => ({ current: undefined as unknown }) as { current: unknown },
);

vi.mock("@wellregarded/db", () => ({
  listResponseTemplates,
  getResponseTemplate,
  createResponseTemplate,
  updateResponseTemplate,
}));
vi.mock("~/lib/db.server", () => ({
  withRequestDb: (_context: unknown, fn: (db: unknown) => Promise<unknown>) =>
    fn({}),
}));
vi.mock("~/lib/practice-context.server", () => ({ requirePracticeContext }));
vi.mock("~/lib/ai.server", () => ({
  getAiProvider: () => aiProvider.current,
}));
vi.mock("~/lib/flash.server", () => ({
  setFlash: async () => new Headers(),
}));

import { action, loader } from "./settings.templates";

const PRACTICE_ID = "0f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const TEMPLATE_ID = "5f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const STAFF_ID = "3f9619ff-8b86-4d01-b42d-00cf4fc964ff";

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
    practiceName: "Cedar Ridge Dental",
    actor,
    auditActor: { type: "staff" as const, id: STAFF_ID },
    viewer: { viewPrivateFeedback: true, viewPatientIdentity: true },
  };
}

function templateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
    practiceId: PRACTICE_ID,
    name: "Positive review",
    body: "Thank you, {reviewer_name}.",
    tone: "warm",
    active: true,
    ...overrides,
  };
}

function args(fields: Record<string, string>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    body.append(key, value);
  }
  const request = new Request("http://localhost/settings/templates", {
    method: "POST",
    body,
  });
  return {
    request,
    params: {},
    context: {
      cloudflare: {
        env: { ENVIRONMENT: "local" } as unknown as Env,
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
  listResponseTemplates.mockResolvedValue([templateRow()]);
  getResponseTemplate.mockResolvedValue(templateRow());
  createResponseTemplate.mockResolvedValue(templateRow());
  updateResponseTemplate.mockResolvedValue(templateRow());
  aiProvider.current = new FakeAiProvider({ "safety/v1": [{ findings: [] }] });
});

describe("the manage_settings gate", () => {
  it("403s the loader and the action for roles without it", async () => {
    requirePracticeContext.mockResolvedValue(practiceContext("front_desk"));
    await expect(loader(args({}))).rejects.toMatchObject({
      init: { status: 403 },
    });
    await expect(
      action(
        args({ intent: "create", name: "X", body: "Thanks.", tone: "warm" }),
      ),
    ).rejects.toMatchObject({ init: { status: 403 } });
    expect(createResponseTemplate).not.toHaveBeenCalled();
  });
});

describe("the template linter (placeholder whitelist)", () => {
  it("rejects unknown placeholders at save with a field error", async () => {
    const result = await action(
      args({
        intent: "create",
        name: "Sneaky",
        body: "See you on {appointment_date}, {reviewer_name}.",
        tone: "warm",
      }),
    );
    expect(result).toMatchObject({ init: { status: 422 } });
    const payload = (result as { data: { fieldErrors: { body: string[] } } })
      .data;
    expect(payload.fieldErrors.body[0]).toContain("{appointment_date}");
    expect(payload.fieldErrors.body[0]).toContain("{reviewer_name}");
    expect(createResponseTemplate).not.toHaveBeenCalled();
  });

  it("accepts the two whitelisted placeholders", async () => {
    const result = await action(
      args({
        intent: "create",
        name: "Fine",
        body: "Thanks, {reviewer_name} — the {practice_name} team.",
        tone: "warm",
      }),
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect(createResponseTemplate).toHaveBeenCalled();
  });
});

describe("the save-time safety gate", () => {
  it("block findings make the template unstorable — 'your root canal' never saves", async () => {
    const result = await action(
      args({
        intent: "create",
        name: "Unsafe",
        body: "We're sorry your root canal hurt, {reviewer_name}.",
        tone: "apologetic",
      }),
    );
    expect(result).toMatchObject({
      init: { status: 422 },
      data: { safety: { level: "block" } },
    });
    expect(createResponseTemplate).not.toHaveBeenCalled();
  });

  it("checks the body with dummies substituted, not the raw tokens", async () => {
    const provider = new FakeAiProvider({ "safety/v1": [{ findings: [] }] });
    aiProvider.current = provider;
    await action(
      args({
        intent: "create",
        name: "Fine",
        body: "Thanks, {reviewer_name} — the {practice_name} team.",
        tone: "warm",
      }),
    );
    const checked = provider.calls[0]?.prompt.user ?? "";
    expect(checked).toContain("Thanks, Alex — the Cedar Ridge Dental team.");
    expect(checked).not.toContain("{reviewer_name}");
  });

  it("warn saves only with the acknowledgment (edit path)", async () => {
    // A phone number in a template is a deterministic warn.
    const fields = {
      intent: "update",
      templateId: TEMPLATE_ID,
      name: "With phone",
      body: "Call us at 555-201-4400 and ask for the practice manager.",
      tone: "neutral",
    };
    aiProvider.current = new FakeAiProvider({
      "safety/v1": [{ findings: [] }, { findings: [] }],
    });

    const bounced = await action(args(fields));
    expect(bounced).toMatchObject({
      init: { status: 422 },
      data: { safety: { level: "warn", needsAcknowledgement: true } },
    });
    expect(updateResponseTemplate).not.toHaveBeenCalled();

    const saved = await action(args({ ...fields, acknowledgeWarnings: "yes" }));
    expect(saved).toBeInstanceOf(Response);
    expect(updateResponseTemplate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        templateId: TEMPLATE_ID,
        patch: expect.objectContaining({ body: fields.body }),
      }),
    );
  });

  it("deterministic blocks hold in degraded AI mode — unsafe templates stay unstorable", async () => {
    const { AiRequestError } = await import("@wellregarded/ai");
    aiProvider.current = {
      classify: () =>
        Promise.reject(new AiRequestError("no key", { attempts: 0 })),
    };
    const result = await action(
      args({
        intent: "create",
        name: "Unsafe",
        body: "Sorry about your appointment on March 3rd.",
        tone: "apologetic",
      }),
    );
    expect(result).toMatchObject({
      init: { status: 422 },
      data: { safety: { level: "block" } },
    });
    expect(createResponseTemplate).not.toHaveBeenCalled();
  });
});

describe("deactivate / activate", () => {
  it("flips the soft flag without a safety re-run and redirects", async () => {
    const result = await action(
      args({ intent: "deactivate", templateId: TEMPLATE_ID }),
    );
    expect(result).toBeInstanceOf(Response);
    expect(updateResponseTemplate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ patch: { active: false } }),
    );

    await action(args({ intent: "activate", templateId: TEMPLATE_ID }));
    expect(updateResponseTemplate).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ patch: { active: true } }),
    );
  });

  it("404s an id outside the practice", async () => {
    updateResponseTemplate.mockResolvedValue(undefined);
    await expect(
      action(args({ intent: "deactivate", templateId: TEMPLATE_ID })),
    ).rejects.toMatchObject({ init: { status: 404 } });
  });
});

describe("validation", () => {
  it("422s an empty name and an unknown tone", async () => {
    const noName = await action(
      args({ intent: "create", name: "  ", body: "Thanks.", tone: "warm" }),
    );
    expect(noName).toMatchObject({ init: { status: 422 } });

    const badTone = await action(
      args({ intent: "create", name: "X", body: "Thanks.", tone: "sassy" }),
    );
    expect(badTone).toMatchObject({ init: { status: 422 } });
    expect(createResponseTemplate).not.toHaveBeenCalled();
  });
});
