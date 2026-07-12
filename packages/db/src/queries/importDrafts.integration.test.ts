/**
 * `import_drafts` helper coverage (issues #134/#135) against a real
 * Postgres via the template-clone harness:
 *
 * - the wizard's shared write paths (#134) — mapping save (stored-header
 *   validation), consent save (choice onto the mapping, note onto the
 *   row), confirm (the start guardrail), and the wizard-step bookmark —
 *   the exact functions BOTH front doors (API routes, dashboard actions)
 *   call;
 * - the Workflow's lifecycle helpers (#135) — practice-scoped reads, the
 *   draft↔run linkage, terminal supersede — plus
 *   `setImportRunArtifactKeys` (the chunk step's post-parse write).
 */

import type { Actor, ColumnMapping } from "@wellregarded/core";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  importDraft,
  importRun,
  practice,
  staffMember,
} from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import { auditLog } from "../schema/audit.js";
import { importDrafts } from "../schema/importDrafts.js";
import { getImportRunArtifactKeys } from "./dedupe.js";
import {
  confirmImportDraft,
  getImportDraft,
  linkImportRunToDraft,
  markImportDraftSuperseded,
  saveImportDraftConsent,
  saveImportDraftMapping,
  setImportDraftWizardStep,
} from "./importDrafts.js";
import { setImportRunArtifactKeys } from "./importRuns.js";

const t = setupTestDb();

const HEADERS = ["Date", "Stars", "Review", "Reviewer", "Patient Email"];

const MAPPING: ColumnMapping = {
  occurredAt: { column: "Date", dateFormat: "MM/DD/YYYY" },
  rating: { column: "Stars", ratingScale: 5 },
  text: { column: "Review" },
  author: { column: "Reviewer" },
  patientEmail: { column: "Patient Email" },
  visibility: { constant: "private" },
};

async function draftFixture(status: "draft" | "confirmed" = "draft") {
  const p = await practice(t.db);
  const staff = await staffMember(t.db, { practiceId: p.id });
  const actor: Actor = { type: "staff", id: staff.id };
  const [draft] = await t.db
    .insert(importDrafts)
    .values({
      practiceId: p.id,
      r2Key: `${p.id}/imports/${"0".repeat(64)}.csv`,
      originalFilename: "legacy reviews.csv",
      byteSize: 1234,
      headers: HEADERS,
      createdBy: staff.id,
      status,
    })
    .returning();
  if (!draft) throw new Error("fixture insert failed");
  return { practice: p, staff, actor, draft };
}

async function auditActions(practiceId: string, action: string) {
  return t.db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.practiceId, practiceId), eq(auditLog.action, action)),
    );
}

describe("getImportDraft", () => {
  it("returns the row for its own practice and undefined across tenants", async () => {
    const draft = await importDraft(t.db);
    const other = await practice(t.db);

    const found = await getImportDraft(t.db, draft.practiceId, draft.id);
    expect(found?.id).toBe(draft.id);
    expect(found?.status).toBe("confirmed");
    expect(found?.mapping).toEqual(draft.mapping);
    expect(found?.importRunId).toBeNull();

    expect(await getImportDraft(t.db, other.id, draft.id)).toBeUndefined();
  });
});

describe("saveImportDraftMapping", () => {
  it("persists, bumps updatedAt, sets the bookmark, audits", async () => {
    const { practice: p, actor, draft } = await draftFixture();
    const result = await saveImportDraftMapping(t.db, {
      practiceId: p.id,
      actor,
      draftId: draft.id,
      mapping: MAPPING,
      wizardStep: "validate",
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error("unreachable");
    expect(result.draft.mapping).toEqual(MAPPING);
    expect(result.draft.wizardStep).toBe("validate");

    const audits = await auditActions(p.id, "import_draft.mapping_saved");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.entityId).toBe(draft.id);
    // Column names and targets only — never cell values.
    expect(audits[0]?.payload).toEqual({ targets: Object.keys(MAPPING) });
  });

  it("rejects columns the stored headers do not have; nothing persists", async () => {
    const { practice: p, actor, draft } = await draftFixture();
    const result = await saveImportDraftMapping(t.db, {
      practiceId: p.id,
      actor,
      draftId: draft.id,
      mapping: { ...MAPPING, text: { column: "Reviews" } },
    });
    expect(result).toEqual({
      outcome: "unknown_columns",
      columns: [{ field: "text", column: "Reviews" }],
    });
    const row = await getImportDraft(t.db, p.id, draft.id);
    expect(row?.mapping).toBeNull();
  });

  it("not_found for cross-practice drafts; not_editable once confirmed", async () => {
    const other = await draftFixture();
    const { practice: p, actor } = await draftFixture();
    expect(
      await saveImportDraftMapping(t.db, {
        practiceId: p.id,
        actor,
        draftId: other.draft.id,
        mapping: MAPPING,
      }),
    ).toEqual({ outcome: "not_found" });

    const confirmed = await draftFixture("confirmed");
    expect(
      await saveImportDraftMapping(t.db, {
        practiceId: confirmed.practice.id,
        actor: confirmed.actor,
        draftId: confirmed.draft.id,
        mapping: MAPPING,
      }),
    ).toEqual({ outcome: "not_editable", status: "confirmed" });
  });
});

describe("saveImportDraftConsent", () => {
  it("practice_attested lands on the mapping with the trimmed note", async () => {
    const { practice: p, actor, draft } = await draftFixture();
    await saveImportDraftMapping(t.db, {
      practiceId: p.id,
      actor,
      draftId: draft.id,
      mapping: MAPPING,
    });

    const result = await saveImportDraftConsent(t.db, {
      practiceId: p.id,
      actor,
      draftId: draft.id,
      consentChoice: "practice_attested",
      attestationNote: "  Signed intake forms 2021–2024  ",
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error("unreachable");
    expect(result.draft.mapping?.consentHint).toEqual({
      constant: "practice_attested",
    });
    expect(result.draft.attestationNote).toBe("Signed intake forms 2021–2024");
    expect(result.draft.wizardStep).toBe("confirm");

    const audits = await auditActions(p.id, "import_draft.consent_saved");
    expect(audits).toHaveLength(1);
    // The note's text stays on the row, out of the audit payload.
    expect(audits[0]?.payload).toEqual({
      consentChoice: "practice_attested",
      hasAttestationNote: true,
    });
  });

  it("imported_unknown clears any stale attestation note", async () => {
    const { practice: p, actor, draft } = await draftFixture();
    await saveImportDraftMapping(t.db, {
      practiceId: p.id,
      actor,
      draftId: draft.id,
      mapping: MAPPING,
    });
    await saveImportDraftConsent(t.db, {
      practiceId: p.id,
      actor,
      draftId: draft.id,
      consentChoice: "practice_attested",
      attestationNote: "old note",
    });

    const result = await saveImportDraftConsent(t.db, {
      practiceId: p.id,
      actor,
      draftId: draft.id,
      consentChoice: "imported_unknown",
      attestationNote: "should be ignored",
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error("unreachable");
    expect(result.draft.mapping?.consentHint).toEqual({
      constant: "imported_unknown",
    });
    expect(result.draft.attestationNote).toBeNull();
  });

  it("mapping_missing before the mapping step has saved", async () => {
    const { practice: p, actor, draft } = await draftFixture();
    expect(
      await saveImportDraftConsent(t.db, {
        practiceId: p.id,
        actor,
        draftId: draft.id,
        consentChoice: "imported_unknown",
        attestationNote: null,
      }),
    ).toEqual({ outcome: "mapping_missing" });
  });
});

describe("confirmImportDraft (the start guardrail, server-side)", () => {
  it("blocks with the shared issues while consent is owed", async () => {
    const { practice: p, actor, draft } = await draftFixture();
    await saveImportDraftMapping(t.db, {
      practiceId: p.id,
      actor,
      draftId: draft.id,
      mapping: MAPPING, // private + PII, no consentHint yet
    });

    const blocked = await confirmImportDraft(t.db, {
      practiceId: p.id,
      actor,
      draftId: draft.id,
    });
    expect(blocked.outcome).toBe("blocked");
    if (blocked.outcome !== "blocked") throw new Error("unreachable");
    expect(blocked.issues.map((i) => i.code)).toEqual(["consent_missing"]);

    const row = await getImportDraft(t.db, p.id, draft.id);
    expect(row?.status).toBe("draft");
  });

  it("confirms a complete draft and audits; a second confirm is not_editable", async () => {
    const { practice: p, actor, draft } = await draftFixture();
    await saveImportDraftMapping(t.db, {
      practiceId: p.id,
      actor,
      draftId: draft.id,
      mapping: MAPPING,
    });
    await saveImportDraftConsent(t.db, {
      practiceId: p.id,
      actor,
      draftId: draft.id,
      consentChoice: "imported_unknown",
      attestationNote: null,
    });

    const result = await confirmImportDraft(t.db, {
      practiceId: p.id,
      actor,
      draftId: draft.id,
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error("unreachable");
    expect(result.draft.status).toBe("confirmed");

    const audits = await auditActions(p.id, "import_draft.confirmed");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.entityId).toBe(draft.id);

    expect(
      await confirmImportDraft(t.db, {
        practiceId: p.id,
        actor,
        draftId: draft.id,
      }),
    ).toEqual({ outcome: "not_editable", status: "confirmed" });
  });

  it("blocks a draft with no mapping at all", async () => {
    const { practice: p, actor, draft } = await draftFixture();
    const result = await confirmImportDraft(t.db, {
      practiceId: p.id,
      actor,
      draftId: draft.id,
    });
    expect(result.outcome).toBe("blocked");
    if (result.outcome !== "blocked") throw new Error("unreachable");
    expect(result.issues.map((i) => i.code)).toEqual(["mapping_missing"]);
  });
});

describe("setImportDraftWizardStep", () => {
  it("moves the bookmark on editable drafts only, without auditing", async () => {
    const { practice: p, draft } = await draftFixture();
    const updated = await setImportDraftWizardStep(t.db, {
      practiceId: p.id,
      draftId: draft.id,
      step: "consent",
    });
    expect(updated?.wizardStep).toBe("consent");

    const confirmed = await draftFixture("confirmed");
    expect(
      await setImportDraftWizardStep(t.db, {
        practiceId: confirmed.practice.id,
        draftId: confirmed.draft.id,
        step: "map",
      }),
    ).toBeUndefined();

    // No audit rows for bookmarks.
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.practiceId, p.id));
    expect(audits).toEqual([]);
  });
});

describe("linkImportRunToDraft / markImportDraftSuperseded", () => {
  it("records the run id and later retires the draft", async () => {
    const draft = await importDraft(t.db);
    const run = await importRun(t.db, { practiceId: draft.practiceId });

    await linkImportRunToDraft(t.db, draft.id, run.id);
    let updated = await getImportDraft(t.db, draft.practiceId, draft.id);
    expect(updated?.importRunId).toBe(run.id);
    expect(updated?.status).toBe("confirmed");

    await markImportDraftSuperseded(t.db, draft.id);
    updated = await getImportDraft(t.db, draft.practiceId, draft.id);
    expect(updated?.status).toBe("superseded");
    // The linkage survives the terminal transition — the report UI (#137)
    // follows it from either side.
    expect(updated?.importRunId).toBe(run.id);
  });
});

describe("setImportRunArtifactKeys", () => {
  it("replaces the run's recorded keys (what dedupe's re-read path consumes)", async () => {
    const run = await importRun(t.db, { rawArtifactKeys: [] });
    const keys = ["p/csv_import/aaa.json", "p/csv_import/bbb.json"];

    await setImportRunArtifactKeys(t.db, run.id, keys);
    expect(await getImportRunArtifactKeys(t.db, run.id)).toEqual(keys);
  });
});
