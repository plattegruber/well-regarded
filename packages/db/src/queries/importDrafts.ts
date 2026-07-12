/**
 * `import_drafts` helpers for the import Workflow (issue #135, Epic #8) —
 * the sanctioned read/write paths the Workflow uses around a draft's
 * lifecycle. The upload endpoint (#133) and wizard (#134) own the
 * `draft → confirmed` transitions; the Workflow owns everything after:
 * linking the run it opened, and retiring the draft once the run
 * finalizes.
 */

import { and, eq } from "drizzle-orm";

import type { Tx } from "../audit.js";
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
