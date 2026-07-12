/**
 * `manualEntryAdapter` — the real manual-entry `SourceAdapter` (issue
 * #138, Epic #8), registered for `sourceKind: "manual"` and replacing the
 * #101 reference fixture adapter that held the slot.
 *
 * One stored envelope (./schema.ts, written by `POST /api/signals/manual`
 * in workers/api) → exactly one `NormalizedSignal`:
 *
 * - **Idempotent identity**: `sourceId` is the UUID minted at submission
 *   time and embedded in the artifact — re-normalizing the same artifact
 *   (redelivery, dedupe's re-read path #106) always yields the same id.
 * - **Visibility is pinned `private`**: manual entries are private
 *   feedback at M1; a public toggle is deliberately omitted from the form
 *   and from this mapping (issue #138 requirement 1).
 * - **Structured choices → hints with `basis: "manual"`**: the form's
 *   location/provider selects arrive as NAMES; the normalize stage
 *   resolves them back to FKs by exact match, exactly like every other
 *   source (#104). A human picked them, hence `manual`, not
 *   `source_metadata`.
 * - **Patient → `patientHint`** (consistent with `supportsIdentity:
 *   true`); the PII lands in `pii.*` through the normalize seam, never
 *   here.
 * - **Consent**: "No / Not asked" → `consentHint: "imported_unknown"` and
 *   nothing else — the absence of a `consents` row IS the state. A
 *   practice attestation → `consentHint: "practice_attested"` plus
 *   `consentDetail` (channels, note, attester), which the normalize
 *   stage's consent seam turns into a real `consents` row.
 *
 * A malformed ENVELOPE throws — that is our own bug, and the normalize
 * stage turns it into a non-retryable failure recorded on the import run.
 * A degenerate artifact (`entry: null`) yields `[]`.
 */

import type { NormalizedSignal } from "../contract/normalizedSignal.js";
import type { SourceAdapter } from "../contract/sourceAdapter.js";
import { manualEntryArtifactSchema } from "./schema.js";

export const manualEntryAdapter: SourceAdapter = {
  sourceKind: "manual",
  capabilities: {
    supportsIdentity: true,
    supportsConsent: true,
    supportsPolling: false,
  },
  async normalize(rawArtifact: unknown): Promise<NormalizedSignal[]> {
    const artifact = manualEntryArtifactSchema.parse(rawArtifact);
    const entry = artifact.entry;
    if (entry === null) return [];

    const signal: NormalizedSignal = {
      // Pinned at M1 — see module doc; no public toggle exists upstream.
      visibility: "private",
      occurredAt: entry.occurredAt,
      originalText: entry.text,
      // Manual entries carry no rating and no source-native author handle;
      // the patient (when given) rides `patientHint` into pii.*, never a
      // display-name column.
      rating: null,
      authorDisplayName: null,
      authorExternalId: null,
      sourceKind: "manual",
      sourceId: artifact.sourceId,
      sourceUrl: null,
    };
    if (entry.providerName !== undefined) {
      signal.providerHint = { text: entry.providerName, basis: "manual" };
    }
    if (entry.locationName !== undefined) {
      signal.locationHint = { text: entry.locationName, basis: "manual" };
    }
    if (entry.patient !== undefined) {
      signal.patientHint = entry.patient;
    }
    if (entry.consent.choice === "practice_attested") {
      signal.consentHint = "practice_attested";
      signal.consentDetail = {
        channels: entry.consent.channels,
        note: entry.consent.note,
        grantedBy: artifact.enteredBy,
        grantedAt: artifact.enteredAt,
      };
    } else {
      // "No / Not asked": usable for analysis, never publishable until a
      // consent record exists (the epic's structural rule).
      signal.consentHint = "imported_unknown";
    }
    return [signal];
  },
};
