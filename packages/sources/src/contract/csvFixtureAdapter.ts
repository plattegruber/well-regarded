/**
 * Second test-only reference adapter (issue #104): a minimal `csv_import`
 * adapter over a fixed row shape, so the normalize stage's
 * resolve-by-sourceKind is meaningfully exercised with two kinds. Exported
 * from `@wellregarded/sources/testing` only and NOT registered in the
 * default registry — tests call `registerAdapter(csvFixtureAdapter)`
 * themselves. The real CSV adapter (with scale detection and column
 * mapping) is Epic #8's job.
 *
 * Unlike the manual fixture adapter it declares `supportsIdentity`, so a
 * row's contact columns become a `patientHint` and the pipeline's PII seam
 * (#104 requirement 4) has something to bite in tests.
 */

import type { NormalizedSignal } from "./normalizedSignal.js";
import type { SourceAdapter } from "./sourceAdapter.js";

/** The fixed artifact shape the CSV fixture adapter understands. */
export interface CsvFixtureArtifact {
  rows: Array<{
    /** Stable per-row ID (e.g. the export's row number) — becomes `sourceId`. */
    rowId: string;
    /** ISO datetime of the experience. */
    submittedAt: string;
    comment?: string;
    /** On a 5-point scale, matching the fixture's pretend export. */
    score?: number;
    patientName?: string;
    patientEmail?: string;
    provider?: string;
    location?: string;
  }>;
}

function isCsvFixtureArtifact(
  artifact: unknown,
): artifact is CsvFixtureArtifact {
  return (
    typeof artifact === "object" &&
    artifact !== null &&
    Array.isArray((artifact as { rows?: unknown }).rows)
  );
}

export const csvFixtureAdapter: SourceAdapter = {
  sourceKind: "csv_import",
  capabilities: {
    supportsIdentity: true,
    supportsConsent: true,
    supportsPolling: false,
  },
  normalize(rawArtifact: unknown): Promise<NormalizedSignal[]> {
    if (!isCsvFixtureArtifact(rawArtifact)) {
      return Promise.reject(
        new Error("csvFixtureAdapter: artifact is not a CsvFixtureArtifact"),
      );
    }
    return Promise.resolve(
      rawArtifact.rows.map((row): NormalizedSignal => {
        const signal: NormalizedSignal = {
          visibility: "private",
          occurredAt: row.submittedAt,
          originalText: row.comment ?? null,
          rating:
            row.score === undefined ? null : { value: row.score, scale: 5 },
          authorDisplayName: row.patientName ?? null,
          authorExternalId: null,
          sourceKind: "csv_import",
          sourceId: row.rowId,
          sourceUrl: null,
          consentHint: "imported_unknown",
        };
        if (row.patientName !== undefined || row.patientEmail !== undefined) {
          signal.patientHint = {
            ...(row.patientName !== undefined ? { name: row.patientName } : {}),
            ...(row.patientEmail !== undefined
              ? { email: row.patientEmail }
              : {}),
          };
        }
        // CSV columns are structured data, not prose — source_metadata basis.
        if (row.provider !== undefined) {
          signal.providerHint = {
            text: row.provider,
            basis: "source_metadata",
          };
        }
        if (row.location !== undefined) {
          signal.locationHint = {
            text: row.location,
            basis: "source_metadata",
          };
        }
        return signal;
      }),
    );
  },
};

/** A realistic fixture payload for the CSV reference adapter's contract run. */
export const csvFixtureArtifact: CsvFixtureArtifact = {
  rows: [
    {
      rowId: "row-1",
      submittedAt: "2026-04-01T10:00:00Z",
      comment: "The hygiene team here is the most careful I have experienced.",
      score: 5,
      patientName: "R. Alvarez",
      patientEmail: "r.alvarez@example.com",
      provider: "Dr. Patel",
      location: "Main Street office",
    },
    {
      rowId: "row-2",
      submittedAt: "2026-04-02T15:30:00-05:00",
      score: 3,
      comment: "Care was fine; the waiting room gets cramped.",
    },
  ],
};

/** The degenerate (empty-batch) payload for the contract suite. */
export const emptyCsvFixtureArtifact: CsvFixtureArtifact = { rows: [] };
