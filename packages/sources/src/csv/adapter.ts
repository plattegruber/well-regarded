/**
 * `csvImportAdapter` — the CSV import `SourceAdapter` (issue #135, Epic
 * #8), registered for `sourceKind: "csv_import"`.
 *
 * One stored batch artifact (envelope in ./schema.ts, written by the
 * import Workflow's chunk step in `workers/jobs`) → one `NormalizedSignal`
 * per row that passes the shared row validation (./validateRow.ts — the
 * SAME functions the wizard's preview and the Workflow's row accounting
 * use, issue #134 requirement 2):
 *
 * - **Mapping as confirmed**: the envelope embeds the `ColumnMapping`
 *   snapshot, so normalization is immune to later draft edits.
 * - **Rows that fail validation are SKIPPED, not thrown**: row errors must
 *   never abort the batch (#135 requirement 2). The Workflow already
 *   recorded each failing row on the import run (counted `failed`, with
 *   the row number as the payload ref) during the chunk step; the skip
 *   here is deterministic — same shared validator, same embedded mapping —
 *   so repeated normalization (contract suite, dedupe's re-read path
 *   #106) always yields the same signals.
 * - **Deterministic identity**: `sourceId = sha256(draftId + ":" +
 *   rowNumber)` — stable across re-runs/resumes of the same draft; a
 *   re-uploaded corrected file is a new draft (see csvRowSourceId).
 * - **PII columns → `patientHint`** (name/email/phone), consistent with
 *   `supportsIdentity: true`; hints carry `basis: "source_metadata"`
 *   (structured columns, not prose); `visibility`/`consentHint` come from
 *   the mapping's column or bulk constant, defaulting to
 *   private/`imported_unknown` (the epic's structural consent rule).
 *
 * A malformed ENVELOPE (wrong kind, missing mapping, non-string cells)
 * throws — that is our own bug, and the normalize stage turns it into a
 * non-retryable failure recorded on the import run, the intended loud
 * path. A degenerate batch (`rows: []`) yields `[]`.
 */

import type { NormalizedSignal } from "../contract/normalizedSignal.js";
import type { SourceAdapter } from "../contract/sourceAdapter.js";
import { csvImportBatchArtifactSchema } from "./schema.js";
import { csvRowSourceId, validateCsvRow } from "./validateRow.js";

export const csvImportAdapter: SourceAdapter = {
  sourceKind: "csv_import",
  capabilities: {
    supportsIdentity: true,
    supportsConsent: true,
    supportsPolling: false,
  },
  async normalize(rawArtifact: unknown): Promise<NormalizedSignal[]> {
    const artifact = csvImportBatchArtifactSchema.parse(rawArtifact);
    const signals: NormalizedSignal[] = [];
    for (const [index, row] of artifact.rows.entries()) {
      const rowNumber = artifact.firstRowNumber + index;
      const validated = validateCsvRow(
        artifact.mapping,
        artifact.headers,
        row,
        rowNumber,
      );
      // Deterministic skip — see module doc; the Workflow owns the
      // failure accounting for these rows.
      if (!validated.ok) continue;
      signals.push({
        ...validated.candidate,
        sourceKind: "csv_import",
        sourceId: await csvRowSourceId(artifact.draftId, rowNumber),
      });
    }
    return signals;
  },
};
