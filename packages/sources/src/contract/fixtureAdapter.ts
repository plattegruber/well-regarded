/**
 * Test-only reference SourceAdapter (issue #101, requirement 5).
 *
 * A trivial adapter over a fixed JSON shape whose sole purpose is to
 * exercise `describeAdapterContract` in this package's own CI, proving the
 * suite runs before any real adapter exists. It is exported from
 * `@wellregarded/sources/testing` only.
 *
 * This is deliberately NOT the manual-entry adapter — that ships with the
 * manual-entry form (issue #138, Epic #8) and normalizes the real form
 * payload. This one exists only so the contract suite has something to bite.
 */

import type { EntityHint, NormalizedSignal } from "./normalizedSignal.js";
import type { SourceAdapter } from "./sourceAdapter.js";

/** The fixed artifact shape the fixture adapter understands. */
export interface FixtureArtifact {
  entries: Array<{
    /** Stable per-entry ID — becomes `sourceId`. */
    id: string;
    /** ISO datetime of the experience. */
    when: string;
    text?: string;
    /** On a 5-point scale, matching the fixture's pretend source. */
    rating?: number;
    author?: string;
    provider?: string;
    location?: string;
    attested?: boolean;
  }>;
}

function isFixtureArtifact(artifact: unknown): artifact is FixtureArtifact {
  return (
    typeof artifact === "object" &&
    artifact !== null &&
    Array.isArray((artifact as { entries?: unknown }).entries)
  );
}

const manualHint = (text: string): EntityHint => ({ text, basis: "manual" });

export const fixtureAdapter: SourceAdapter = {
  sourceKind: "manual",
  capabilities: {
    supportsIdentity: false,
    supportsConsent: true,
    supportsPolling: false,
  },
  normalize(rawArtifact: unknown): Promise<NormalizedSignal[]> {
    if (!isFixtureArtifact(rawArtifact)) {
      return Promise.reject(
        new Error("fixtureAdapter: artifact is not a FixtureArtifact"),
      );
    }
    return Promise.resolve(
      rawArtifact.entries.map((entry): NormalizedSignal => {
        const signal: NormalizedSignal = {
          visibility: "private",
          occurredAt: entry.when,
          originalText: entry.text ?? null,
          rating:
            entry.rating === undefined
              ? null
              : { value: entry.rating, scale: 5 },
          authorDisplayName: entry.author ?? null,
          authorExternalId: null,
          sourceKind: "manual",
          sourceId: entry.id,
          sourceUrl: null,
        };
        if (entry.provider !== undefined) {
          signal.providerHint = manualHint(entry.provider);
        }
        if (entry.location !== undefined) {
          signal.locationHint = manualHint(entry.location);
        }
        if (entry.attested !== undefined) {
          signal.consentHint = entry.attested
            ? "practice_attested"
            : "imported_unknown";
        }
        return signal;
      }),
    );
  },
};

/** A realistic fixture payload for the reference adapter's own contract run. */
export const fixtureArtifact: FixtureArtifact = {
  entries: [
    {
      id: "entry-1",
      when: "2026-03-02T14:30:00Z",
      text: "Dr. Patel was wonderful with my daughter — she actually looks forward to the dentist now.",
      rating: 5,
      author: "A grateful parent",
      provider: "Dr. Patel",
      location: "Main Street office",
      attested: true,
    },
    {
      id: "entry-2",
      when: "2026-03-03T09:00:00-05:00",
      rating: 4,
    },
    {
      id: "entry-3",
      when: "2026-03-04T11:15:00Z",
      text: "Front desk fit me in the same day for a broken crown.",
      attested: false,
    },
  ],
};

/** The degenerate (empty-batch) payload for the contract suite. */
export const emptyFixtureArtifact: FixtureArtifact = { entries: [] };
