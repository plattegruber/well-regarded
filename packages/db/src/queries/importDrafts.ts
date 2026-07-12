/**
 * `import_drafts` helpers (issues #134/#135, Epic #8) — the sanctioned
 * read/write paths around a draft's lifecycle. The wizard's mutations
 * (mapping save, consent save, confirm) are shared by BOTH front doors —
 * the API worker's import routes and the dashboard wizard's actions — so
 * the two surfaces cannot drift on validation, status rules, or auditing.
 * The Workflow (#135) owns everything after `confirmed`: linking the run
 * it opened, and retiring the draft once the run finalizes.
 *
 * Every wizard mutation re-checks the draft inside its own transaction
 * (status must still be `draft`), audits in that same transaction, and
 * returns a discriminated outcome instead of throwing — callers translate
 * outcomes into their own status codes / flash messages.
 */

import {
  type Actor,
  type ColumnMapping,
  type ImportConsentHint,
  type ImportDraftStatus,
  type ImportStartIssue,
  type ImportTargetField,
  type ImportWizardStep,
  importStartIssues,
  unknownMappingColumns,
} from "@wellregarded/core";
import { and, eq } from "drizzle-orm";

import { audit, type Tx } from "../audit.js";
import type { Db } from "../client.js";
import { importDrafts } from "../schema/importDrafts.js";

/** An `import_drafts` row. */
export type ImportDraft = typeof importDrafts.$inferSelect;

/**
 * Practice-scoped draft read: a draft id from another practice returns
 * `undefined`, same posture as `getImportRunSummary`.
 */
export async function getImportDraft(
  db: Db | Tx,
  practiceId: string,
  draftId: string,
): Promise<ImportDraft | undefined> {
  const [row] = await db
    .select()
    .from(importDrafts)
    .where(
      and(
        eq(importDrafts.id, draftId),
        eq(importDrafts.practiceId, practiceId),
      ),
    )
    .limit(1);
  return row;
}

export type SaveImportDraftMappingResult =
  | { outcome: "ok"; draft: ImportDraft }
  | { outcome: "not_found" }
  | { outcome: "not_editable"; status: ImportDraftStatus }
  | {
      outcome: "unknown_columns";
      columns: Array<{ field: ImportTargetField; column: string }>;
    };

/**
 * Save the wizard's mapping onto a draft: check every referenced column
 * against the draft's STORED headers (a mapping naming a column the file
 * doesn't have is rejected, not a silent no-op at import time), persist,
 * audit. Only `status = draft` rows are editable. `wizardStep`, when
 * given, advances the resume bookmark in the same write.
 */
export async function saveImportDraftMapping(
  db: Db,
  input: {
    practiceId: string;
    actor: Actor;
    draftId: string;
    mapping: ColumnMapping;
    wizardStep?: ImportWizardStep;
  },
): Promise<SaveImportDraftMappingResult> {
  return db.transaction(async (tx) => {
    const draft = await getImportDraft(tx, input.practiceId, input.draftId);
    if (!draft) return { outcome: "not_found" as const };
    if (draft.status !== "draft") {
      return { outcome: "not_editable" as const, status: draft.status };
    }

    const unknown = unknownMappingColumns(input.mapping, draft.headers);
    if (unknown.length > 0) {
      return { outcome: "unknown_columns" as const, columns: unknown };
    }

    const [updated] = await tx
      .update(importDrafts)
      .set({
        mapping: input.mapping,
        ...(input.wizardStep !== undefined
          ? { wizardStep: input.wizardStep }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(importDrafts.id, draft.id))
      .returning();
    if (!updated) throw new Error("import draft update returned no row");
    await audit(tx, {
      practiceId: input.practiceId,
      actor: input.actor,
      action: "import_draft.mapping_saved",
      entityType: "import_drafts",
      entityId: draft.id,
      // Column names and targets only — mapping never holds cell values.
      payload: { targets: Object.keys(input.mapping) },
    });
    return { outcome: "ok" as const, draft: updated };
  });
}

export type SaveImportDraftConsentResult =
  | { outcome: "ok"; draft: ImportDraft }
  | { outcome: "not_found" }
  | { outcome: "not_editable"; status: ImportDraftStatus }
  /** The consent step comes after mapping; no mapping ⇒ nothing to attach to. */
  | { outcome: "mapping_missing" };

/**
 * Record the wizard's bulk consent choice (#134 step 3): the choice lands
 * on `mapping.consentHint` as a whole-file constant (the shape the
 * Workflow #135 executes), the attestation note on its own column. An
 * `imported_unknown` choice clears any stale note — the note documents an
 * attestation, so it cannot outlive one.
 */
export async function saveImportDraftConsent(
  db: Db,
  input: {
    practiceId: string;
    actor: Actor;
    draftId: string;
    consentChoice: ImportConsentHint;
    attestationNote: string | null;
  },
): Promise<SaveImportDraftConsentResult> {
  return db.transaction(async (tx) => {
    const draft = await getImportDraft(tx, input.practiceId, input.draftId);
    if (!draft) return { outcome: "not_found" as const };
    if (draft.status !== "draft") {
      return { outcome: "not_editable" as const, status: draft.status };
    }
    if (draft.mapping === null) {
      return { outcome: "mapping_missing" as const };
    }

    const attestationNote =
      input.consentChoice === "practice_attested"
        ? (input.attestationNote?.trim() ?? null)
        : null;
    const mapping: ColumnMapping = {
      ...draft.mapping,
      consentHint: { constant: input.consentChoice },
    };
    const [updated] = await tx
      .update(importDrafts)
      .set({
        mapping,
        attestationNote,
        wizardStep: "confirm",
        updatedAt: new Date(),
      })
      .where(eq(importDrafts.id, draft.id))
      .returning();
    if (!updated) throw new Error("import draft update returned no row");
    await audit(tx, {
      practiceId: input.practiceId,
      actor: input.actor,
      action: "import_draft.consent_saved",
      entityType: "import_drafts",
      entityId: draft.id,
      // The choice matters for the record; the note's text stays on the row.
      payload: {
        consentChoice: input.consentChoice,
        hasAttestationNote: attestationNote !== null,
      },
    });
    return { outcome: "ok" as const, draft: updated };
  });
}

export type ConfirmImportDraftResult =
  | { outcome: "ok"; draft: ImportDraft }
  | { outcome: "not_found" }
  | { outcome: "not_editable"; status: ImportDraftStatus }
  /** The shared start guardrail said no — same issues the wizard shows. */
  | { outcome: "blocked"; issues: ImportStartIssue[] };

/**
 * Confirm a draft (#134 step 4 / req. 6): re-run the shared
 * `importStartIssues` guardrail server-side — the wizard can never confirm
 * a draft this function would reject, because the wizard asks the same
 * function — then flip `status` to `confirmed` and audit. The import
 * Workflow (#135) consumes exactly this state.
 */
export async function confirmImportDraft(
  db: Db,
  input: { practiceId: string; actor: Actor; draftId: string },
): Promise<ConfirmImportDraftResult> {
  return db.transaction(async (tx) => {
    const draft = await getImportDraft(tx, input.practiceId, input.draftId);
    if (!draft) return { outcome: "not_found" as const };
    if (draft.status !== "draft") {
      return { outcome: "not_editable" as const, status: draft.status };
    }

    const issues = importStartIssues({
      mapping: draft.mapping,
      headers: draft.headers,
      attestationNote: draft.attestationNote,
    });
    if (issues.length > 0) {
      return { outcome: "blocked" as const, issues };
    }

    const [updated] = await tx
      .update(importDrafts)
      .set({
        status: "confirmed",
        wizardStep: "confirm",
        updatedAt: new Date(),
      })
      .where(eq(importDrafts.id, draft.id))
      .returning();
    if (!updated) throw new Error("import draft update returned no row");
    await audit(tx, {
      practiceId: input.practiceId,
      actor: input.actor,
      action: "import_draft.confirmed",
      entityType: "import_drafts",
      entityId: draft.id,
      payload: {
        r2Key: draft.r2Key,
        targets: draft.mapping ? Object.keys(draft.mapping) : [],
      },
    });
    return { outcome: "ok" as const, draft: updated };
  });
}

/**
 * Move the resume bookmark without changing anything else — the validate
 * step's "continue" persists progress this way. Not audited: it is a UI
 * bookmark, not a meaningful mutation. No-op (returning `undefined`) for
 * unknown, cross-practice, or already-confirmed drafts.
 */
export async function setImportDraftWizardStep(
  db: Db | Tx,
  input: { practiceId: string; draftId: string; step: ImportWizardStep },
): Promise<ImportDraft | undefined> {
  const [updated] = await db
    .update(importDrafts)
    .set({ wizardStep: input.step, updatedAt: new Date() })
    .where(
      and(
        eq(importDrafts.id, input.draftId),
        eq(importDrafts.practiceId, input.practiceId),
        eq(importDrafts.status, "draft"),
      ),
    )
    .returning();
  return updated;
}

/**
 * Record which `import_runs` row is executing this draft (issue #135
 * requirement 5: the draft/run linkage must be queryable — the report UI
 * #137 follows it). Called by the Workflow's validate step, in the same
 * transaction as `createImportRun`.
 */
export async function linkImportRunToDraft(
  db: Db | Tx,
  draftId: string,
  importRunId: string,
): Promise<void> {
  await db
    .update(importDrafts)
    .set({ importRunId, updatedAt: new Date() })
    .where(eq(importDrafts.id, draftId));
}

/**
 * Retire a draft once its import run has finalized (#135 step 5): the
 * mapping has been executed, so the draft can never be started again —
 * `superseded` is the terminal parking state (re-importing means a fresh
 * upload → a new draft). Deliberately NOT called when the Workflow fails:
 * a failed run leaves the draft `confirmed` so the import can be retried.
 */
export async function markImportDraftSuperseded(
  db: Db | Tx,
  draftId: string,
): Promise<void> {
  await db
    .update(importDrafts)
    .set({ status: "superseded", updatedAt: new Date() })
    .where(eq(importDrafts.id, draftId));
}
