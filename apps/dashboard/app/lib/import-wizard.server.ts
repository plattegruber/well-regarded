// Shared loader plumbing for the CSV mapping wizard (#134). Every step's
// data comes through `loadWizardData`: the practice-scoped draft row (404
// for unknown/cross-practice ids, in one breath), the 256KB preview window
// re-read from R2 (same ranged discipline as the upload endpoint — never
// the whole object), per-column detection, and — once a mapping exists —
// the validation preview computed with the EXACT row validator the import
// Workflow (#135) runs (`validateCsvRow`, reshaped by
// `validateCsvPreviewRows` in @wellregarded/sources), so the preview
// cannot lie.
//
// Terminal drafts (confirmed/superseded) bounce back to the imports page
// with a flash instead of rendering an editable wizard.

import {
  type ColumnDetection,
  type ColumnMapping,
  consentRequiredForMapping,
  detectColumns,
  type ImportWizardStep,
  PREVIEW_WINDOW_BYTES,
  parseCsvPreview,
  unknownMappingColumns,
} from "@wellregarded/core";
import { getImportDraft } from "@wellregarded/db";
import {
  type CsvPreviewValidation,
  getRawImportHead,
  validateCsvPreviewRows,
} from "@wellregarded/sources";
import { type AppLoadContext, data, redirect } from "react-router";

import { withRequestDb } from "~/lib/db.server";
import { setFlash } from "~/lib/flash.server";
import {
  type PracticeContext,
  requirePracticeContext,
} from "~/lib/practice-context.server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate the `:draftId` URL param before it reaches a uuid-typed query
 * (Postgres would throw on a malformed cast) — non-uuids are plain 404s.
 */
export function requireDraftIdParam(draftId: string | undefined): string {
  if (!draftId || !UUID_RE.test(draftId)) {
    throw data(null, { status: 404 });
  }
  return draftId;
}

export interface WizardDraft {
  id: string;
  originalFilename: string;
  byteSize: number;
  headers: string[];
  mapping: ColumnMapping | null;
  attestationNote: string | null;
  wizardStep: ImportWizardStep | null;
}

export interface WizardData {
  draft: WizardDraft;
  previewRows: string[][];
  detected: ColumnDetection[];
  /** Whether the consent step applies to the saved mapping (null ⇒ not yet knowable). */
  consentRequired: boolean | null;
  /**
   * The validation preview for the SAVED mapping — present once step 1 has
   * saved one (and its columns still match the stored headers).
   */
  validation: CsvPreviewValidation | null;
}

/**
 * Resolve auth + draft + preview for a wizard step. Throws the redirects
 * and 404s itself so step loaders stay one-liners.
 */
export async function loadWizardData(
  context: AppLoadContext,
  draftIdParam: string | undefined,
): Promise<WizardData & { ctx: PracticeContext }> {
  const draftId = requireDraftIdParam(draftIdParam);

  return withRequestDb(context, async (db) => {
    // TODO(#59): requirePracticeContext is the auth seam — see its module doc.
    const ctx = await requirePracticeContext(db);
    const draft = await getImportDraft(db, ctx.practiceId, draftId);
    if (!draft) throw data(null, { status: 404 });
    if (draft.status !== "draft") {
      // Confirmed drafts belong to the Workflow (#135) and its report page
      // (#137); superseded ones were replaced by a newer upload.
      throw redirect("/settings/imports", {
        headers: await setFlash(context.cloudflare.env, {
          tone: "neutral",
          message:
            draft.status === "confirmed"
              ? "That import was already confirmed"
              : "That upload was replaced by a newer one",
        }),
      });
    }

    const head = await getRawImportHead(
      context.cloudflare.env.RAW_IMPORTS,
      draft.r2Key,
      PREVIEW_WINDOW_BYTES,
    );
    const preview = parseCsvPreview(head.bytes, { truncated: head.truncated });
    if (preview === null) {
      // It parsed at upload time; losing that now is our bug, not theirs.
      throw data("The stored file can't be previewed anymore.", {
        status: 500,
      });
    }

    const mapping = draft.mapping;
    const mappingUsable =
      mapping !== null &&
      unknownMappingColumns(mapping, draft.headers).length === 0;

    return {
      ctx,
      draft: {
        id: draft.id,
        originalFilename: draft.originalFilename,
        byteSize: draft.byteSize,
        headers: draft.headers,
        mapping,
        attestationNote: draft.attestationNote,
        wizardStep: draft.wizardStep,
      },
      previewRows: preview.previewRows,
      detected: detectColumns(draft.headers, preview.previewRows),
      consentRequired: mapping ? consentRequiredForMapping(mapping) : null,
      validation: mappingUsable
        ? validateCsvPreviewRows(mapping, draft.headers, preview.previewRows)
        : null,
    };
  });
}
