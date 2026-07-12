// Action-recipe tests for the duplicate resolve action (#90), in the node
// environment (loaders/actions are server code). The write + audit itself
// is integration-tested in packages/db (resolveSuspectedDuplicate); here we
// assert the recipe around it: permission check, parse-don't-throw, the
// call contract, and the flash + redirect.
import type { StaffActor } from "@wellregarded/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveSuspectedDuplicate = vi.hoisted(() => vi.fn());
const confirmDerivation = vi.hoisted(() => vi.fn());
const reclassifyDerivation = vi.hoisted(() => vi.fn());
const setSignalAssociation = vi.hoisted(() => vi.fn());
const requirePracticeContext = vi.hoisted(() => vi.fn());

vi.mock("@wellregarded/db", () => ({
  getSignalDetail: vi.fn(),
  listSignalFilterOptions: vi.fn(),
  confirmDerivation,
  reclassifyDerivation,
  resolveSuspectedDuplicate,
  setSignalAssociation,
}));
vi.mock("~/lib/db.server", () => ({
  // The action's queries run against whatever db the wrapper hands over —
  // a stub here; the real factory is exercised by the dev-server smoke run.
  withRequestDb: (_context: unknown, fn: (db: unknown) => Promise<unknown>) =>
    fn({}),
}));
vi.mock("~/lib/practice-context.server", () => ({ requirePracticeContext }));

import { action } from "./signals.$signalId";

const PRACTICE_ID = "0f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const SIGNAL_ID = "1f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const DUPLICATE_ID = "2f9619ff-8b86-4d01-b42d-00cf4fc964ff";
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

function actionArgs(fields: Record<string, string>, signalId = SIGNAL_ID) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    body.append(key, value);
  }
  const request = new Request(`http://localhost/signals/${signalId}`, {
    method: "POST",
    body,
  });
  return {
    request,
    params: { signalId },
    context: {
      cloudflare: {
        env: { ENVIRONMENT: "local" } as Env,
        ctx: {} as ExecutionContext,
      },
      requestId: "test-request-id",
      // biome-ignore lint/suspicious/noExplicitAny: the action never logs in these paths
      logger: undefined as any,
    },
    // biome-ignore lint/suspicious/noExplicitAny: route arg typing is generated per-route; the test erases it
  } as any;
}

const VALID = {
  intent: "resolve-duplicate",
  duplicateId: DUPLICATE_ID,
  resolution: "different",
};

beforeEach(() => {
  vi.clearAllMocks();
  requirePracticeContext.mockResolvedValue(practiceContext("owner"));
});

describe("duplicate resolve action", () => {
  it("resolves, flashes, and redirects back to the detail page", async () => {
    resolveSuspectedDuplicate.mockResolvedValue({ status: "dismissed" });
    const result = await action(actionArgs(VALID));
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`/signals/${SIGNAL_ID}`);
    expect(response.headers.get("Set-Cookie")).toContain("__wr_flash");

    // The write goes through the audited db helper with the real actor.
    expect(resolveSuspectedDuplicate).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      {
        practiceId: PRACTICE_ID,
        duplicateId: DUPLICATE_ID,
        resolution: "different",
        actor: { type: "staff", id: STAFF_ID },
      },
    );
  });

  it("treats an already-resolved link as a quiet no-op, not an error", async () => {
    resolveSuspectedDuplicate.mockResolvedValue(undefined);
    const result = await action(actionArgs({ ...VALID, resolution: "same" }));
    expect((result as Response).status).toBe(302);
  });

  it("403s for a role the matrix denies — hidden buttons are not a boundary", async () => {
    requirePracticeContext.mockResolvedValue(practiceContext("marketing"));
    await expect(action(actionArgs(VALID))).rejects.toMatchObject({
      init: { status: 403 },
    });
    expect(resolveSuspectedDuplicate).not.toHaveBeenCalled();
  });

  it("returns 422 field errors for a bad resolution — never throws", async () => {
    const result = await action(actionArgs({ ...VALID, resolution: "merge" }));
    expect(result).toMatchObject({ init: { status: 422 } });
    expect(resolveSuspectedDuplicate).not.toHaveBeenCalled();
  });

  it("returns 422 for a malformed duplicate id", async () => {
    const result = await action(
      actionArgs({ ...VALID, duplicateId: "not-a-uuid" }),
    );
    expect(result).toMatchObject({ init: { status: 422 } });
  });

  it("404s a malformed signal id before touching anything", async () => {
    await expect(action(actionArgs(VALID, "nope"))).rejects.toMatchObject({
      init: { status: 404 },
    });
    expect(requirePracticeContext).not.toHaveBeenCalled();
  });
});

describe("reclassify actions (#93)", () => {
  it("✓ quick-confirm calls the audited helper for the dimension and flashes", async () => {
    confirmDerivation.mockResolvedValue({ id: "row", basis: "manual" });
    const result = await action(
      actionArgs({ intent: "confirm-derivation", dimension: "sentiment" }),
    );
    const response = result as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`/signals/${SIGNAL_ID}`);
    expect(confirmDerivation).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      {
        practiceId: PRACTICE_ID,
        signalId: SIGNAL_ID,
        dimension: "sentiment",
        actor: { type: "staff", id: STAFF_ID },
      },
    );
  });

  it("✓ on a changed judgment is a quiet no-op, not an error", async () => {
    confirmDerivation.mockResolvedValue(undefined);
    const result = await action(
      actionArgs({ intent: "confirm-derivation", dimension: "urgency" }),
    );
    expect((result as Response).status).toBe(302);
  });

  it("correction calls the append-only helper with the picked value", async () => {
    reclassifyDerivation.mockResolvedValue({ id: "row", basis: "manual" });
    const result = await action(
      actionArgs({
        intent: "reclassify-derivation",
        dimension: "urgency",
        value: "high",
      }),
    );
    expect((result as Response).status).toBe(302);
    expect(reclassifyDerivation).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      {
        practiceId: PRACTICE_ID,
        signalId: SIGNAL_ID,
        dimension: "urgency",
        value: "high",
        actor: { type: "staff", id: STAFF_ID },
      },
    );
  });

  it("422s a value outside the dimension's vocabulary — never throws", async () => {
    const result = await action(
      actionArgs({
        intent: "reclassify-derivation",
        dimension: "sentiment",
        value: "critical", // an urgency value, not a sentiment
      }),
    );
    expect(result).toMatchObject({ init: { status: 422 } });
    expect(reclassifyDerivation).not.toHaveBeenCalled();
  });

  it("association confirm maps 'none' to a NULL association", async () => {
    setSignalAssociation.mockResolvedValue({ id: SIGNAL_ID });
    const result = await action(
      actionArgs({
        intent: "set-association",
        kind: "provider",
        entityId: "none",
      }),
    );
    expect((result as Response).status).toBe(302);
    expect(setSignalAssociation).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      {
        practiceId: PRACTICE_ID,
        signalId: SIGNAL_ID,
        kind: "provider",
        entityId: null,
        actor: { type: "staff", id: STAFF_ID },
      },
    );
  });

  it("422s a malformed association target", async () => {
    const result = await action(
      actionArgs({
        intent: "set-association",
        kind: "location",
        entityId: "not-a-uuid",
      }),
    );
    expect(result).toMatchObject({ init: { status: 422 } });
    expect(setSignalAssociation).not.toHaveBeenCalled();
  });

  it("403s reclassification for a role the matrix denies (marketing)", async () => {
    requirePracticeContext.mockResolvedValue(practiceContext("marketing"));
    await expect(
      action(
        actionArgs({ intent: "confirm-derivation", dimension: "sentiment" }),
      ),
    ).rejects.toMatchObject({ init: { status: 403 } });
    expect(confirmDerivation).not.toHaveBeenCalled();
  });

  it("front_desk (scoped) may reclassify practice-wide resources", async () => {
    requirePracticeContext.mockResolvedValue(practiceContext("front_desk"));
    confirmDerivation.mockResolvedValue({ id: "row" });
    const result = await action(
      actionArgs({ intent: "confirm-derivation", dimension: "sentiment" }),
    );
    expect((result as Response).status).toBe(302);
  });
});
