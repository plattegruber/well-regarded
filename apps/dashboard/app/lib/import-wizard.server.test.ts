// loadWizardData (#134): the one loader path behind every wizard step —
// draft scoping, the ranged preview re-read, detection, and the shared
// validation preview. DB and R2 are mocked; the CSV parsing, detection,
// and row validation are the REAL @wellregarded/core functions.
import type { ColumnMapping } from "@wellregarded/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getImportDraft = vi.hoisted(() => vi.fn());
const getRawImportHead = vi.hoisted(() => vi.fn());
const requirePracticeContext = vi.hoisted(() => vi.fn());

vi.mock("@wellregarded/db", () => ({ getImportDraft }));
// Only the R2 read is faked; validateCsvPreviewRows stays REAL — the test
// asserts the actual shared validator's output shape.
vi.mock("@wellregarded/sources", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRawImportHead,
}));
vi.mock("~/lib/db.server", () => ({
  withRequestDb: (_context: unknown, fn: (db: unknown) => Promise<unknown>) =>
    fn({}),
}));
vi.mock("~/lib/practice-context.server", () => ({ requirePracticeContext }));

import { loadWizardData } from "./import-wizard.server";

const PRACTICE_ID = "0f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const DRAFT_ID = "1f9619ff-8b86-4d01-b42d-00cf4fc964ff";

const CSV = [
  "Date,Stars,Review",
  "01/13/2024,5,Great cleaning",
  "13/45/2023,4,Nice visit",
  "",
].join("\n");

const MAPPING: ColumnMapping = {
  occurredAt: { column: "Date", dateFormat: "MM/DD/YYYY" },
  rating: { column: "Stars", ratingScale: 5 },
  text: { column: "Review" },
  visibility: { constant: "private" },
};

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID,
    practiceId: PRACTICE_ID,
    r2Key: `${PRACTICE_ID}/imports/${"0".repeat(64)}.csv`,
    originalFilename: "legacy.csv",
    byteSize: CSV.length,
    headers: ["Date", "Stars", "Review"],
    mapping: null,
    attestationNote: null,
    wizardStep: null,
    status: "draft",
    ...overrides,
  };
}

const context = {
  cloudflare: {
    env: { ENVIRONMENT: "local", RAW_IMPORTS: {} } as unknown as Env,
    ctx: {} as ExecutionContext,
  },
  // biome-ignore lint/suspicious/noExplicitAny: loaders don't touch the rest in these paths
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  requirePracticeContext.mockResolvedValue({
    practiceId: PRACTICE_ID,
    actor: { type: "staff", staffId: "s", practiceId: PRACTICE_ID },
    auditActor: { type: "staff", id: "s" },
    viewer: { viewPrivateFeedback: true, viewPatientIdentity: true },
  });
  getRawImportHead.mockResolvedValue({
    bytes: new TextEncoder().encode(CSV),
    truncated: false,
  });
});

describe("loadWizardData", () => {
  it("returns draft, preview rows, detection — validation once a mapping exists", async () => {
    getImportDraft.mockResolvedValue(draftRow({ mapping: MAPPING }));
    const data = await loadWizardData(context, DRAFT_ID);

    expect(data.draft).toMatchObject({
      id: DRAFT_ID,
      originalFilename: "legacy.csv",
      headers: ["Date", "Stars", "Review"],
      mapping: MAPPING,
    });
    expect(data.previewRows).toEqual([
      ["01/13/2024", "5", "Great cleaning"],
      ["13/45/2023", "4", "Nice visit"],
    ]);
    expect(data.detected.map((d) => d.suggestedTarget)).toEqual([
      "occurredAt",
      "rating",
      "text",
    ]);
    // Private visibility ⇒ the consent step applies.
    expect(data.consentRequired).toBe(true);
    // The shared validator flagged the DD/MM-looking row under MM/DD/YYYY.
    expect(data.validation?.rowCount).toBe(2);
    expect(data.validation?.failingRowCount).toBe(1);
    expect(data.validation?.issues[0]?.message).toContain(
      "isn't a date in the format you chose",
    );
  });

  it("no mapping yet ⇒ no validation, consentRequired unknown", async () => {
    getImportDraft.mockResolvedValue(draftRow());
    const data = await loadWizardData(context, DRAFT_ID);
    expect(data.validation).toBeNull();
    expect(data.consentRequired).toBeNull();
  });

  it("404s malformed ids without touching the db, and unknown drafts after", async () => {
    await expect(loadWizardData(context, "nope")).rejects.toMatchObject({
      init: { status: 404 },
    });
    expect(requirePracticeContext).not.toHaveBeenCalled();

    getImportDraft.mockResolvedValue(undefined);
    await expect(loadWizardData(context, DRAFT_ID)).rejects.toMatchObject({
      init: { status: 404 },
    });
  });

  it("bounces terminal drafts back to the imports page with a flash", async () => {
    getImportDraft.mockResolvedValue(draftRow({ status: "confirmed" }));
    let thrown: unknown;
    try {
      await loadWizardData(context, DRAFT_ID);
    } catch (error) {
      thrown = error;
    }
    const response = thrown as Response;
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/settings/imports");
    expect(response.headers.get("Set-Cookie")).toContain("__wr_flash");
  });
});
