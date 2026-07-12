/**
 * Google reviews adapter tests (issue #125):
 *
 * 1. the shared SourceAdapter contract suite over the RECORDED fixtures
 *    (`./fixtures/*.json`, generated from the fake GBP server #130 — a
 *    pinning test in ../fake/fixtures.test.ts keeps them in lockstep);
 * 2. Google-specific assertions for every quirk in requirement 2 —
 *    star-only, edited, replied (all three moderation states), anonymized,
 *    1-star with text, translation passthrough, unknown starRating;
 * 3. a golden test: page 1 → the exact expected NormalizedSignal list
 *    (snapshot), so any mapping change is a visible, reviewed diff.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { describeAdapterContract } from "../contract/describeAdapterContract.js";
import type { NormalizedSignal } from "../contract/normalizedSignal.js";
import { googleReviewsAdapter } from "./adapter.js";
import {
  GOOGLE_REVIEWS_ARTIFACT_KIND,
  type GoogleReviewsArtifact,
} from "./schema.js";

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(`${fixturesDir}${name}`, "utf8"));
}

const page1 = (await loadFixture("reviews.list.page1.json")) as {
  reviews: unknown[];
};
const page2 = (await loadFixture("reviews.list.page2.json")) as {
  reviews: unknown[];
};
const emptyPage = await loadFixture("reviews.list.empty.json");

const PRACTICE_ID = "3f2b6a1e-90cd-4f5e-8a2f-1b0f4a7c9d21";
const LOCATION_NAME = "accounts/1/locations/1";

/** Wrap a recorded page in the poller's artifact envelope (#123 contract). */
function envelope(page: unknown): GoogleReviewsArtifact {
  return {
    kind: GOOGLE_REVIEWS_ARTIFACT_KIND,
    envelopeVersion: 1,
    practiceId: PRACTICE_ID,
    googleLocationName: LOCATION_NAME,
    fetchedAt: "2026-07-01T00:00:00.000Z",
    page,
  } as GoogleReviewsArtifact;
}

/** A recorded-shape single-review page for targeted quirk cases. */
function reviewEnvelope(review: object): GoogleReviewsArtifact {
  return envelope({ reviews: [review], totalReviewCount: 1 });
}

async function normalizeOne(review: object): Promise<NormalizedSignal> {
  const signals = await googleReviewsAdapter.normalize(reviewEnvelope(review));
  expect(signals).toHaveLength(1);
  const signal = signals[0];
  if (signal === undefined) throw new Error("unreachable: length asserted");
  return signal;
}

async function findByName(name: string): Promise<NormalizedSignal> {
  for (const page of [page1, page2]) {
    const signals = await googleReviewsAdapter.normalize(envelope(page));
    const match = signals.find((signal) => signal.sourceId === name);
    if (match) return match;
  }
  throw new Error(`no fixture review named ${name}`);
}

// The shared cross-source contract suite (Epic #6).
describeAdapterContract(googleReviewsAdapter, {
  valid: [
    {
      name: "recorded reviews page 1",
      artifact: envelope(page1),
      expectedCount: page1.reviews.length,
    },
    {
      name: "recorded reviews page 2",
      artifact: envelope(page2),
      expectedCount: page2.reviews.length,
    },
  ],
  empty: envelope(emptyPage),
});

describe("googleReviewsAdapter capabilities (#125 requirement 1)", () => {
  it("declares google, no identity, no consent, polling", () => {
    expect(googleReviewsAdapter.sourceKind).toBe("google");
    expect(googleReviewsAdapter.capabilities).toEqual({
      supportsIdentity: false,
      supportsConsent: false,
      supportsPolling: true,
    });
  });
});

describe("field mapping (#125 requirement 2)", () => {
  it("maps every field of a plain 5-star review with text", async () => {
    // Recorded fixture: Brad Huang, FIVE, unedited, no reply.
    const signal = await findByName("accounts/1/locations/1/reviews/9");
    expect(signal).toEqual({
      visibility: "public",
      occurredAt: "2026-04-29T11:37:12.000Z",
      originalText:
        "They took my kids (4 and 7) for their first checkups — patient, funny, zero tears. We found our family dentist.",
      rating: { value: 5, scale: 5 },
      authorDisplayName: "Brad Huang",
      authorExternalId: null,
      sourceKind: "google",
      sourceId: "accounts/1/locations/1/reviews/9",
      sourceUrl: null,
      locationHint: { text: LOCATION_NAME, basis: "source_metadata" },
      sourceMetadata: { sourceUpdatedAt: "2026-04-29T11:37:12.000Z" },
    });
  });

  it("maps the starRating enum totally: ONE..FIVE → 1..5 on scale 5", async () => {
    const expected = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
    for (const [starRating, value] of Object.entries(expected)) {
      const signal = await normalizeOne({
        name: "accounts/1/locations/1/reviews/99",
        reviewId: "99",
        reviewer: { displayName: "Maria Delgado" },
        starRating,
        comment: "Fine.",
        createTime: "2026-05-01T09:00:00.000Z",
        updateTime: "2026-05-01T09:00:00.000Z",
      });
      expect(signal.rating).toEqual({ value, scale: 5 });
    }
  });

  it("1-star with text keeps both the rating and the exact text", async () => {
    const signal = await normalizeOne({
      name: "accounts/1/locations/1/reviews/31",
      reviewId: "31",
      reviewer: {
        displayName: "Omar Ferris",
        profilePhotoUrl: "https://lh3.googleusercontent.com/a/fake-omar-ferris",
      },
      starRating: "ONE",
      comment:
        "Waited 50 minutes and then the appointment felt rushed. Not coming back.",
      createTime: "2026-02-14T16:20:00.000Z",
      updateTime: "2026-02-14T16:20:00.000Z",
    });
    expect(signal.rating).toEqual({ value: 1, scale: 5 });
    expect(signal.originalText).toBe(
      "Waited 50 minutes and then the appointment felt rushed. Not coming back.",
    );
  });

  it("star-only review: a valid rating-only signal with null text (never dropped)", async () => {
    // Recorded fixture: Scott Okafor, FOUR, no `comment` key at all.
    const signal = await findByName("accounts/1/locations/1/reviews/14");
    expect(signal.originalText).toBeNull();
    expect(signal.rating).toEqual({ value: 4, scale: 5 });
    // And it counts toward the page's signal total (contract suite pins
    // expectedCount = every review on the page, star-only included).
  });

  it("edited review: occurredAt stays createTime; updateTime rides sourceMetadata", async () => {
    // Recorded fixture: Victor Tran, edited (updateTime > createTime, no reply).
    const signal = await findByName("accounts/1/locations/1/reviews/2");
    expect(signal.occurredAt).toBe("2025-07-25T15:13:43.000Z");
    expect(signal.sourceMetadata?.sourceUpdatedAt).toBe(
      "2025-08-02T15:13:43.000Z",
    );
  });

  it("anonymized reviewer → null authorDisplayName, never the placeholder", async () => {
    // Recorded fixture: "A Google user", isAnonymous: true.
    const signal = await findByName("accounts/1/locations/1/reviews/11");
    expect(signal.authorDisplayName).toBeNull();
    expect(signal.authorExternalId).toBeNull();
  });

  it("named reviewer → displayName carried; authorExternalId always null", async () => {
    const signal = await findByName("accounts/1/locations/1/reviews/9");
    expect(signal.authorDisplayName).toBe("Brad Huang");
    expect(signal.authorExternalId).toBeNull();
  });

  it("keeps Google's translation wrapper byte-for-byte (no translation handling at M1)", async () => {
    const wrapped =
      "(Translated by Google) Great dentist!\n\n(Original)\n¡Gran dentista!";
    const signal = await normalizeOne({
      name: "accounts/1/locations/1/reviews/32",
      reviewId: "32",
      reviewer: { displayName: "Nadia Sandoval" },
      starRating: "FIVE",
      comment: wrapped,
      createTime: "2026-03-03T10:00:00.000Z",
      updateTime: "2026-03-03T10:00:00.000Z",
    });
    expect(signal.originalText).toBe(wrapped);
  });

  it("locationHint carries the envelope's googleLocationName with basis source_metadata", async () => {
    const signals = await googleReviewsAdapter.normalize(envelope(page1));
    for (const signal of signals) {
      expect(signal.locationHint).toEqual({
        text: LOCATION_NAME,
        basis: "source_metadata",
      });
      expect(signal.visibility).toBe("public");
      expect(signal.sourceKind).toBe("google");
      expect(signal.sourceId).toMatch(
        /^accounts\/1\/locations\/1\/reviews\/\d+$/,
      );
    }
  });
});

describe("existing owner replies (#125 requirement 2, ADR 0002 §2)", () => {
  it("APPROVED reply → existingReply with comment, updateTime, state", async () => {
    // Recorded fixture: Derek Marsh's review, reply APPROVED.
    const signal = await findByName("accounts/1/locations/1/reviews/15");
    expect(signal.sourceMetadata?.existingReply).toEqual({
      comment:
        "We apologize for the billing confusion. Our manager has reached out to help resolve the insurance claim.",
      updateTime: "2026-04-21T12:39:15.000Z",
      state: "APPROVED",
    });
  });

  it("PENDING reply → captured with state PENDING (a 200 PUT is not 'live')", async () => {
    // Recorded fixture: Derek Huang's review, reply PENDING.
    const signal = await findByName("accounts/1/locations/1/reviews/6");
    expect(signal.sourceMetadata?.existingReply).toMatchObject({
      state: "PENDING",
    });
    expect(signal.sourceMetadata?.existingReply?.policyViolation).toBe(
      undefined,
    );
  });

  it("REJECTED reply → captured with state and the policyViolation reason", async () => {
    // Recorded fixture: Elena Gutierrez's review, reply REJECTED.
    const signal = await findByName("accounts/1/locations/1/reviews/4");
    expect(signal.sourceMetadata?.existingReply).toEqual({
      comment:
        "We apologize for the billing confusion. Our manager has reached out to help resolve the insurance claim.",
      updateTime: "2026-06-12T05:35:36.000Z",
      state: "REJECTED",
      policyViolation:
        "Reply removed for policy violation: contains personal health information.",
    });
  });

  it("no reply → no existingReply key", async () => {
    const signal = await findByName("accounts/1/locations/1/reviews/9");
    expect(signal.sourceMetadata?.existingReply).toBe(undefined);
  });
});

describe("defensive parsing: shape drift fails the artifact loudly", () => {
  const baseReview = {
    name: "accounts/1/locations/1/reviews/40",
    reviewId: "40",
    reviewer: { displayName: "Kate Roy" },
    starRating: "FIVE",
    comment: "Great.",
    createTime: "2026-05-01T09:00:00.000Z",
    updateTime: "2026-05-01T09:00:00.000Z",
  };

  it("rejects STAR_RATING_UNSPECIFIED (the lookup is total over ONE..FIVE)", async () => {
    await expect(
      googleReviewsAdapter.normalize(
        reviewEnvelope({
          ...baseReview,
          starRating: "STAR_RATING_UNSPECIFIED",
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects an unknown starRating value", async () => {
    await expect(
      googleReviewsAdapter.normalize(
        reviewEnvelope({ ...baseReview, starRating: "SIX" }),
      ),
    ).rejects.toThrow();
  });

  it("rejects a truncated review resource name (sourceId is load-bearing)", async () => {
    await expect(
      googleReviewsAdapter.normalize(
        reviewEnvelope({ ...baseReview, name: "reviews/40" }),
      ),
    ).rejects.toThrow();
  });

  it("rejects a bare reviews page without the poller's envelope", async () => {
    await expect(googleReviewsAdapter.normalize(page1)).rejects.toThrow();
  });

  it("rejects an envelope missing its location mapping context", async () => {
    const { googleLocationName: _dropped, ...broken } = envelope(page1);
    await expect(googleReviewsAdapter.normalize(broken)).rejects.toThrow();
  });

  it("tolerates unknown fields on the review (2026 added three of them)", async () => {
    const signal = await normalizeOne({
      ...baseReview,
      reviewMediaItems: [
        {
          name: "accounts/1/locations/1/media/7",
          mediaFormat: "PHOTO",
          googleUrl: "https://lh3.googleusercontent.com/p/fake",
        },
      ],
      someFieldGoogleShipsNextYear: true,
    });
    expect(signal.rating).toEqual({ value: 5, scale: 5 });
  });
});

describe("golden normalize (#125 testing note)", () => {
  it("page 1 → the exact expected NormalizedSignal list", async () => {
    expect(
      await googleReviewsAdapter.normalize(envelope(page1)),
    ).toMatchSnapshot();
  });

  it("page 2 → the exact expected NormalizedSignal list", async () => {
    expect(
      await googleReviewsAdapter.normalize(envelope(page2)),
    ).toMatchSnapshot();
  });
});
