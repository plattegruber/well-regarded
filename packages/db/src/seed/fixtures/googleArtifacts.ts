/**
 * Demo raw artifacts for the seeded Google reviews (issue #214).
 *
 * The seed itself writes only Postgres — but every seeded Google signal
 * carries a `raw_artifact_key` (`raw/google/demo/{key}.json`), and the
 * reply-import backfill (workers/jobs) re-reads exactly those artifacts.
 * This module builds the matching review-page envelopes (the #123 poller
 * shape from `@wellregarded/sources`' `googleReviewsArtifactSchema`) from
 * the committed fixtures, so integration tests — and a local-dev bucket —
 * can hold provenance that agrees with the seeded rows:
 *
 * - one single-review page per signal, keyed by the signal's
 *   `raw_artifact_key`;
 * - the review `name` IS the signal's `source_id` (see
 *   {@link demoGoogleReviewName} — a REAL v4 resource name as of seed v3,
 *   because the publish/reply flows treat `source_id` as the GBP resource
 *   name and the artifact schema rejects anything else);
 * - fixtures with an `existingReply` carry it as `reviewReply`, which is
 *   what the #214 backfill imports.
 *
 * Deliberately built as plain object literals (no `@wellregarded/sources`
 * import — packages/db does not depend on it); the jobs-worker backfill
 * test normalizes these through the real adapter, which pins the shape.
 */

import { daysBeforeAnchor, SEED_ANCHOR } from "../constants.js";
import type { SignalFixture } from "./signals.js";
import { SIGNAL_FIXTURES } from "./signals.js";

/** The demo GBP account every seeded location hangs off. */
export const DEMO_GOOGLE_ACCOUNT = "accounts/demo";

/** v4 location parent for a fixture (`accounts/demo/locations/{loc}`). */
export function demoGoogleLocationName(fixture: SignalFixture): string {
  return `${DEMO_GOOGLE_ACCOUNT}/locations/${fixture.location ?? "main_street"}`;
}

/**
 * The fixture's v4 review resource name — the seeded signal's `source_id`
 * (seed v3) AND the review `name` inside its demo artifact. Changing this
 * function is a `SEED_VERSION` bump.
 */
export function demoGoogleReviewName(fixture: SignalFixture): string {
  return `${demoGoogleLocationName(fixture)}/reviews/${fixture.key}`;
}

/** The seeded signal's R2 key for its demo artifact. */
export function demoGoogleArtifactKey(fixture: SignalFixture): string {
  return `raw/google/demo/${fixture.key}.json`;
}

const STAR_RATINGS: Record<string, string> = {
  "1.0": "ONE",
  "2.0": "TWO",
  "3.0": "THREE",
  "4.0": "FOUR",
  "5.0": "FIVE",
};

/** One demo artifact: the R2 key plus the stored envelope. */
export interface DemoGoogleArtifact {
  key: string;
  /** JSON-serializable — store with `JSON.stringify(artifact)`. */
  artifact: Record<string, unknown>;
}

function toArtifact(
  practiceId: string,
  fixture: SignalFixture,
): DemoGoogleArtifact {
  const rating = fixture.rating === undefined ? null : fixture.rating;
  if (rating === null || STAR_RATINGS[rating] === undefined) {
    throw new Error(
      `demo google fixture "${fixture.key}" has no ratable star rating`,
    );
  }
  // Whole-day timestamps on purpose: the artifact is provenance for the
  // backfill (which only reads `reviewReply`), not the source of the
  // seeded row's `occurred_at` (run.ts adds its deterministic hour offset).
  const createTime = daysBeforeAnchor(fixture.daysAgo).toISOString();
  const review: Record<string, unknown> = {
    name: demoGoogleReviewName(fixture),
    reviewer: { isAnonymous: true },
    starRating: STAR_RATINGS[rating],
    ...(fixture.text.length > 0 ? { comment: fixture.text } : {}),
    createTime,
    updateTime: createTime,
    ...(fixture.existingReply === undefined
      ? {}
      : {
          reviewReply: {
            comment: fixture.existingReply.comment,
            updateTime: daysBeforeAnchor(
              fixture.existingReply.updatedDaysAgo,
            ).toISOString(),
            reviewReplyState: fixture.existingReply.state,
            ...(fixture.existingReply.policyViolation !== undefined
              ? { policyViolation: fixture.existingReply.policyViolation }
              : {}),
          },
        }),
  };
  return {
    key: demoGoogleArtifactKey(fixture),
    artifact: {
      kind: "gbp.reviews.page",
      envelopeVersion: 1,
      practiceId,
      googleLocationName: demoGoogleLocationName(fixture),
      fetchedAt: SEED_ANCHOR.toISOString(),
      page: { reviews: [review] },
    },
  };
}

/**
 * Every seeded Google signal's demo artifact, in fixture order. Callers
 * (the backfill integration test; a local-dev R2 loader) put each
 * `artifact` under its `key`.
 */
export function demoGoogleArtifacts(practiceId: string): DemoGoogleArtifact[] {
  return SIGNAL_FIXTURES.filter(
    (fixture) => fixture.sourceKind === "google",
  ).map((fixture) => toArtifact(practiceId, fixture));
}
