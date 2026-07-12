// Action-recipe tests for Settings → AI (#75), node environment. The
// audited upsert itself is integration-tested in packages/db
// (practiceSettings.integration.test.ts); here we assert the recipe
// around it: the manage_settings gate, parse-don't-throw (dollars →
// cents, empty = no cap), preservation of model overrides the form does
// not carry, and the flash + redirect.
import type { StaffActor } from "@wellregarded/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getPracticeAiSettings = vi.hoisted(() => vi.fn());
const updatePracticeAiSettings = vi.hoisted(() => vi.fn());
const practiceAiStatus = vi.hoisted(() => vi.fn());
const requirePracticeContext = vi.hoisted(() => vi.fn());
const setFlash = vi.hoisted(() => vi.fn());

vi.mock("@wellregarded/db", () => ({
  getPracticeAiSettings,
  updatePracticeAiSettings,
  practiceAiStatus,
}));
vi.mock("~/lib/db.server", () => ({
  withRequestDb: (_context: unknown, fn: (db: unknown) => Promise<unknown>) =>
    fn({}),
}));
vi.mock("~/lib/practice-context.server", () => ({ requirePracticeContext }));
vi.mock("~/lib/flash.server", () => ({ setFlash }));

import { action } from "./settings.ai";

const PRACTICE_ID = "0f9619ff-8b86-4d01-b42d-00cf4fc964ff";
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
    actor,
    auditActor: { type: "staff" as const, id: STAFF_ID },
    viewer: { viewPrivateFeedback: true, viewPatientIdentity: true },
  };
}

function actionArgs(fields: Record<string, string>) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    body.append(key, value);
  }
  const request = new Request("http://localhost/settings/ai", {
    method: "POST",
    body,
  });
  return {
    request,
    params: {},
    context: {
      cloudflare: { env: { ENVIRONMENT: "local" }, ctx: {} },
    },
    // biome-ignore lint/suspicious/noExplicitAny: route arg typing is generated per-route; the test erases it
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePracticeContext.mockResolvedValue(practiceContext("owner"));
  getPracticeAiSettings.mockResolvedValue(null);
  updatePracticeAiSettings.mockResolvedValue({});
  setFlash.mockResolvedValue(new Headers());
});

describe("settings/ai action", () => {
  it("403s outright for roles without manage_settings", async () => {
    requirePracticeContext.mockResolvedValue(practiceContext("front_desk"));
    await expect(
      action(actionArgs({ monthlyBudgetDollars: "50" })),
    ).rejects.toMatchObject({ init: { status: 403 } });
    expect(updatePracticeAiSettings).not.toHaveBeenCalled();
  });

  it("saves the toggle + budget (dollars → cents), audited via the helper, then redirects", async () => {
    const result = await action(
      actionArgs({ disabled: "on", monthlyBudgetDollars: "50" }),
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect((result as Response).headers.get("Location")).toBe("/settings/ai");

    expect(updatePracticeAiSettings).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      {
        practiceId: PRACTICE_ID,
        settings: { disabled: true, monthlyBudgetCents: 5_000 },
        actor: { type: "staff", id: STAFF_ID },
      },
    );
    expect(setFlash).toHaveBeenCalledOnce();
  });

  it("an empty budget means no cap (null), unchecked toggle means enabled", async () => {
    await action(actionArgs({ monthlyBudgetDollars: "" }));
    expect(updatePracticeAiSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        settings: { disabled: false, monthlyBudgetCents: null },
      }),
    );
  });

  it("rounds fractional dollars to whole cents", async () => {
    await action(actionArgs({ monthlyBudgetDollars: "12.345" }));
    expect(updatePracticeAiSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        settings: expect.objectContaining({ monthlyBudgetCents: 1_235 }),
      }),
    );
  });

  it("returns 422 fieldErrors for a non-numeric or negative budget", async () => {
    for (const bad of ["abc", "-5"]) {
      const result = await action(actionArgs({ monthlyBudgetDollars: bad }));
      expect(result).toMatchObject({ init: { status: 422 } });
    }
    expect(updatePracticeAiSettings).not.toHaveBeenCalled();
  });

  it("preserves model overrides the form does not carry", async () => {
    getPracticeAiSettings.mockResolvedValue({
      models: { pipeline: "claude-haiku-9" },
      disabled: true,
    });
    await action(actionArgs({ monthlyBudgetDollars: "10" }));
    expect(updatePracticeAiSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        settings: {
          models: { pipeline: "claude-haiku-9" },
          disabled: false,
          monthlyBudgetCents: 1_000,
        },
      }),
    );
  });
});
