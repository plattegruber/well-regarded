/**
 * Drift guard (issue #101 implementation note): `NormalizedSignal` mirrors —
 * deliberately does not import — the source-independent columns of the
 * `signals` table. This test pins the field mapping with a `satisfies` check
 * against the Drizzle insert type, so a column rename/retype in
 * `packages/db/src/schema/signals.ts` fails `pnpm typecheck` here instead of
 * silently drifting. (`@wellregarded/db` is imported as types only; nothing
 * from it runs.)
 */

import type { schema } from "@wellregarded/db";
import { describe, expect, it } from "vitest";

import type { NormalizedSignal } from "./normalizedSignal.js";

type SignalsInsert = typeof schema.signals.$inferInsert;

/**
 * The columns a NormalizedSignal populates. `Pick` (not `Partial`) so a
 * renamed column breaks the type, and `satisfies` so a retyped column breaks
 * the mapping expression.
 */
type SignalsColumnsFromNormalizedSignal = Pick<
  SignalsInsert,
  | "visibility"
  | "occurredAt"
  | "originalText"
  | "originalRating"
  | "sourceKind"
  | "sourceId"
  | "sourceUrl"
>;

function toSignalsColumns(
  signal: NormalizedSignal,
): SignalsColumnsFromNormalizedSignal {
  return {
    visibility: signal.visibility,
    occurredAt: new Date(signal.occurredAt),
    originalText: signal.originalText,
    // numeric column — drizzle infers string. Scale conversion is the
    // normalize stage's policy (#104); this mapping only proves the shapes
    // still line up.
    originalRating: signal.rating === null ? null : String(signal.rating.value),
    sourceKind: signal.sourceKind,
    sourceId: signal.sourceId,
    sourceUrl: signal.sourceUrl,
  } satisfies SignalsColumnsFromNormalizedSignal;
  // Deliberately unmapped: practiceId/rawArtifactKey/importRunId come from
  // pipeline context, patientId/providerId/locationId from entity resolution
  // of the hints (#104), availability/retentionState from lifecycle defaults.
  // authorDisplayName/authorExternalId have no signals column yet — they ride
  // the wire contract for dedupe and future author storage. sourceMetadata
  // (#125) likewise has no column: dedupe threads its sourceUpdatedAt into
  // signal_versions.source_updated_at, and the normalize stage persists
  // existingReply as an imported `responses` row (#214) — neither lands
  // on `signals` itself.
}

describe("NormalizedSignal ↔ signals table drift guard", () => {
  it("maps onto the signals insert type", () => {
    const mapped = toSignalsColumns({
      visibility: "public",
      occurredAt: "2026-03-02T14:30:00Z",
      originalText: "Great visit",
      rating: { value: 4.5, scale: 5 },
      authorDisplayName: null,
      authorExternalId: null,
      sourceKind: "google",
      sourceId: "reviews/3",
      sourceUrl: null,
    });
    expect(mapped.occurredAt.toISOString()).toBe("2026-03-02T14:30:00.000Z");
    expect(mapped.originalRating).toBe("4.5");
  });
});
