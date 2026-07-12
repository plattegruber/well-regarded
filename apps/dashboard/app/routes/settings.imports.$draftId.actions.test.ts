// Action-recipe tests for the wizard's step actions (#134), in the node
// environment. The audited writes themselves are integration-tested in
// packages/db (importDrafts.integration.test.ts); here we assert the
// recipe around them: permission check, parse-don't-throw, the call
// contract into the shared db helpers, and the redirects that walk the
// steps.
import type { StaffActor } from "@wellregarded/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getImportDraft = vi.hoisted(() => vi.fn());
const saveImportDraftMapping = vi.hoisted(() => vi.fn());
const saveImportDraftConsent = vi.hoisted(() => vi.fn());
const setImportDraftWizardStep = vi.hoisted(() => vi.fn());
const confirmImportDraft = vi.hoisted(() => vi.fn());
const requirePracticeContext = vi.hoisted(() => vi.fn());

vi.mock("@wellregarded/db", () => ({
  getImportDraft,
  saveImportDraftMapping,
  saveImportDraftConsent,
  setImportDraftWizardStep,
  confirmImportDraft,
}));
vi.mock("~/lib/db.server", () => ({
  withRequestDb: (_context: unknown, fn: (db: unknown) => Promise<unknown>) =>
    fn({}),
}));
vi.mock("~/lib/practice-context.server", () => ({ requirePracticeContext }));

import { action as confirmAction } from "./settings.imports.$draftId.confirm";
import { action as consentAction } from "./settings.imports.$draftId.consent";
import { action as mapAction } from "./settings.imports.$draftId.map";
import { action as validateAction } from "./settings.imports.$draftId.validate";

const PRACTICE_ID = "0f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const DRAFT_ID = "1f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const STAFF_ID = "3f9619ff-8b86-4d01-b42d-00cf4fc964ff";

const HEADERS = ["Date", "Stars", "Review"];

const MAPPING = {
  occurredAt: { column: "Date", dateFormat: "MM/DD/YYYY" },
  rating: { column: "Stars", ratingScale: 5 },
  text: { column: "Review" },
  visibility: { constant: "private" },
};

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

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID,
    practiceId: PRACTICE_ID,
    headers: HEADERS,
    mapping: null,
    attestationNote: null,
    wizardStep: null,
    status: "draft",
    ...overrides,
  };
}

function actionArgs(
  fields: Record<string, string>,
  step: string,
  draftId = DRAFT_ID,
) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    body.append(key, value);
  }
  const request = new Request(
    `http://localhost/settings/imports/${draftId}/${step}`,
    { method: "POST", body },
  );
  return {
    request,
    params: { draftId },
    context: {
      cloudflare: {
        env: { ENVIRONMENT: "local" } as Env,
        ctx: {} as ExecutionContext,
      },
      requestId: "test-request-id",
      // biome-ignore lint/suspicious/noExplicitAny: the actions never log in these paths
      logger: undefined as any,
    },
    // biome-ignore lint/suspicious/noExplicitAny: route arg typing is generated per-route; the test erases it
  } as any;
}

const VALID_MAP_FIELDS = {
  "column-0": "occurredAt",
  "dateFormat-0": "MM/DD/YYYY",
  "column-1": "rating",
  "ratingScale-1": "5",
  "column-2": "text",
  visibility: "private",
};

beforeEach(() => {
  vi.clearAllMocks();
  requirePracticeContext.mockResolvedValue(practiceContext("owner"));
  getImportDraft.mockResolvedValue(draftRow());
});

describe("map action", () => {
  it("saves the parsed mapping with the validate bookmark and redirects on", async () => {
    saveImportDraftMapping.mockResolvedValue({
      outcome: "ok",
      draft: draftRow({ mapping: MAPPING }),
    });
    const response = (await mapAction(
      actionArgs(VALID_MAP_FIELDS, "map"),
    )) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `/settings/imports/${DRAFT_ID}/validate`,
    );
    expect(response.headers.get("Set-Cookie")).toContain("__wr_flash");

    expect(saveImportDraftMapping).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      {
        practiceId: PRACTICE_ID,
        actor: { type: "staff", id: STAFF_ID },
        draftId: DRAFT_ID,
        mapping: MAPPING,
        wizardStep: "validate",
      },
    );
  });

  it("returns 422 fieldErrors for an incomplete form — never throws, never writes", async () => {
    const { "dateFormat-0": _drop, ...fields } = VALID_MAP_FIELDS;
    const result = await mapAction(actionArgs(fields, "map"));
    expect(result).toMatchObject({
      init: { status: 422 },
      data: {
        fieldErrors: {
          "dateFormat-0": [
            "Choose how these dates should be read before continuing.",
          ],
        },
      },
    });
    expect(saveImportDraftMapping).not.toHaveBeenCalled();
  });

  it("403s for a role the matrix denies", async () => {
    requirePracticeContext.mockResolvedValue(practiceContext("front_desk"));
    await expect(
      mapAction(actionArgs(VALID_MAP_FIELDS, "map")),
    ).rejects.toMatchObject({ init: { status: 403 } });
    expect(saveImportDraftMapping).not.toHaveBeenCalled();
  });

  it("404s a malformed draft id before touching anything", async () => {
    await expect(
      mapAction(actionArgs(VALID_MAP_FIELDS, "map", "not-a-uuid")),
    ).rejects.toMatchObject({ init: { status: 404 } });
    expect(requirePracticeContext).not.toHaveBeenCalled();
  });
});

describe("validate action", () => {
  it("moves the bookmark to consent and redirects", async () => {
    setImportDraftWizardStep.mockResolvedValue(draftRow());
    const response = (await validateAction(
      actionArgs({}, "validate"),
    )) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `/settings/imports/${DRAFT_ID}/consent`,
    );
    expect(setImportDraftWizardStep).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      { practiceId: PRACTICE_ID, draftId: DRAFT_ID, step: "consent" },
    );
  });
});

describe("consent action", () => {
  beforeEach(() => {
    getImportDraft.mockResolvedValue(draftRow({ mapping: MAPPING }));
  });

  it("422s when no choice was made — there is no default", async () => {
    const result = await consentAction(actionArgs({}, "consent"));
    expect(result).toMatchObject({ init: { status: 422 } });
    expect(
      (result as { data: { fieldErrors: Record<string, string[]> } }).data
        .fieldErrors.consentChoice?.[0],
    ).toContain("Choose one");
    expect(saveImportDraftConsent).not.toHaveBeenCalled();
  });

  it("422s practice_attested without an attestation note", async () => {
    const result = await consentAction(
      actionArgs({ consentChoice: "practice_attested" }, "consent"),
    );
    expect(result).toMatchObject({ init: { status: 422 } });
    expect(
      (result as { data: { fieldErrors: Record<string, string[]> } }).data
        .fieldErrors.attestationNote?.[0],
    ).toContain("where the permission lives");
    expect(saveImportDraftConsent).not.toHaveBeenCalled();
  });

  it("saves the choice + note through the audited helper and redirects", async () => {
    saveImportDraftConsent.mockResolvedValue({
      outcome: "ok",
      draft: draftRow(),
    });
    const response = (await consentAction(
      actionArgs(
        {
          consentChoice: "practice_attested",
          attestationNote: " Signed intake forms 2021–2024 ",
        },
        "consent",
      ),
    )) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `/settings/imports/${DRAFT_ID}/confirm`,
    );
    expect(saveImportDraftConsent).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      {
        practiceId: PRACTICE_ID,
        actor: { type: "staff", id: STAFF_ID },
        draftId: DRAFT_ID,
        consentChoice: "practice_attested",
        attestationNote: "Signed intake forms 2021–2024",
      },
    );
  });

  it("skips straight to confirm when the saved mapping needs no consent", async () => {
    getImportDraft.mockResolvedValue(
      draftRow({
        mapping: {
          occurredAt: { column: "Date", dateFormat: "MM/DD/YYYY" },
          text: { column: "Review" },
          visibility: { constant: "public" },
        },
      }),
    );
    const response = (await consentAction(
      actionArgs({}, "consent"),
    )) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `/settings/imports/${DRAFT_ID}/confirm`,
    );
    expect(saveImportDraftConsent).not.toHaveBeenCalled();
    expect(setImportDraftWizardStep).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      { practiceId: PRACTICE_ID, draftId: DRAFT_ID, step: "confirm" },
    );
  });
});

describe("confirm action", () => {
  it("returns the shared guardrail's issues as 422 data when blocked", async () => {
    confirmImportDraft.mockResolvedValue({
      outcome: "blocked",
      issues: [
        {
          code: "consent_missing",
          message: "Answer the consent question before starting.",
        },
      ],
    });
    const result = await confirmAction(actionArgs({}, "confirm"));
    expect(result).toMatchObject({
      init: { status: 422 },
      data: { issues: [{ code: "consent_missing" }] },
    });
  });

  it("confirms, kicks off the Workflow, flashes, and hands off to the imports page", async () => {
    confirmImportDraft.mockResolvedValue({
      outcome: "ok",
      draft: draftRow({ status: "confirmed" }),
    });
    const create = vi.fn().mockResolvedValue({ id: "wf-1" });
    const args = actionArgs({}, "confirm");
    args.context.cloudflare.env.CSV_IMPORT = { create };
    const response = (await confirmAction(args)) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/settings/imports");
    expect(response.headers.get("Set-Cookie")).toContain("__wr_flash");
    expect(confirmImportDraft).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      {
        practiceId: PRACTICE_ID,
        actor: { type: "staff", id: STAFF_ID },
        draftId: DRAFT_ID,
      },
    );
    // One wr-csv-import instance, with the draft/practice/trace params
    // the Workflow's schema expects (docs/csv-import.md § Triggering).
    expect(create).toHaveBeenCalledExactlyOnceWith({
      params: {
        importDraftId: DRAFT_ID,
        practiceId: PRACTICE_ID,
        requestId: "test-request-id",
      },
    });
  });

  it("a missing CSV_IMPORT binding still confirms (local dev without the jobs worker)", async () => {
    confirmImportDraft.mockResolvedValue({
      outcome: "ok",
      draft: draftRow({ status: "confirmed" }),
    });
    const response = (await confirmAction(
      actionArgs({}, "confirm"),
    )) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/settings/imports");
  });

  it("403s for a role the matrix denies", async () => {
    requirePracticeContext.mockResolvedValue(practiceContext("front_desk"));
    await expect(
      confirmAction(actionArgs({}, "confirm")),
    ).rejects.toMatchObject({ init: { status: 403 } });
    expect(confirmImportDraft).not.toHaveBeenCalled();
  });
});
