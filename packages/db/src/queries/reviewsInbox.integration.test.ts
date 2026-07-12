/**
 * Integration coverage for the review inbox reads (issues #76/#77):
 * `listReviewInbox` predicate/filters/ordering/pagination against the
 * seeded demo corpus (fixture arrays are the expectation source, as in
 * `signalsInbox.integration.test.ts`), the exact five-tier ordering
 * against a hand-built fixture set, `countReviewInboxStatuses`, and
 * `getReviewDetail` assembly + its four indistinguishable 404 paths.
 *
 * Tiers 4–5 (drafted/pending approval, responded) derive from `responses`
 * rows (#80). The seeded corpus carries ONLY the #214 imported replies
 * (seed v3: fixtures with `existingReply` are `responded` from the first
 * run; everything else resolves through the documented fallback,
 * `needs_response`); the final describe block seeds dashboard-origin rows
 * and pins the full derivation — keep it last in the file.
 */

import { isNegativeReview, REVIEW_SOURCE_KINDS } from "@wellregarded/core";
import { beforeAll, describe, expect, it } from "vitest";

import {
  derivation as derivationFactory,
  practice as practiceFactory,
  response as responseFactory,
  signal as signalFactory,
  staffMember as staffMemberFactory,
} from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import { LOCATION_FIXTURES } from "../seed/fixtures/demoPractice.js";
import { SIGNAL_FIXTURES } from "../seed/fixtures/signals.js";
import { seedId } from "../seed/ids.js";
import { DEMO_PRACTICE_ID, runSeed } from "../seed/run.js";
import {
  countReviewInboxStatuses,
  decodeReviewsCursor,
  getReviewDetail,
  listReviewInbox,
  type ReviewInboxItem,
} from "./reviewsInbox.js";

const t = setupTestDb();

beforeAll(async () => {
  await runSeed(t.db);
});

const signalId = (key: string) => seedId(`signal:${key}`);

type Fixture = (typeof SIGNAL_FIXTURES)[number];

/** The seeded reviews: public + review-semantics source kind. */
const isReviewFixture = (fixture: Fixture) =>
  fixture.visibility === "public" &&
  (REVIEW_SOURCE_KINDS as readonly string[]).includes(fixture.sourceKind);

const REVIEW_FIXTURES = SIGNAL_FIXTURES.filter(isReviewFixture);

/** Seeded reviews already replied at the source (#214): their imported
 * `responses` rows make them `responded` from the first seed run. */
const IMPORTED_REPLY_FIXTURES = REVIEW_FIXTURES.filter(
  (f) => f.existingReply !== undefined,
);
const importedReplyIds = () =>
  new Set(IMPORTED_REPLY_FIXTURES.map((f) => signalId(f.key)));

/** Manual re-classification outranks the inferred sentiment (Epic #3). */
const effectiveSentiment = (fixture: Fixture) =>
  fixture.manualSentiment ?? fixture.sentiment;

async function collectAllPages(
  params: Omit<Parameters<typeof listReviewInbox>[1], "cursor">,
  pageSize?: number,
): Promise<ReviewInboxItem[]> {
  const items: ReviewInboxItem[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await listReviewInbox(t.db, {
      ...params,
      ...(pageSize === undefined ? {} : { limit: pageSize }),
      cursor,
    });
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    cursor = page.nextCursor;
  }
}

describe("listReviewInbox — the review predicate (integration)", () => {
  it("returns exactly the public review-kind signals, no private feedback", async () => {
    const items = await collectAllPages({ practiceId: DEMO_PRACTICE_ID });
    const expected = new Set(REVIEW_FIXTURES.map((f) => signalId(f.key)));
    expect(new Set(items.map((i) => i.id))).toEqual(expected);
    expect(items).toHaveLength(REVIEW_FIXTURES.length);
    for (const item of items) {
      expect(REVIEW_SOURCE_KINDS).toContain(item.sourceKind);
    }
  });

  it("resolves unresponded reviews to needs_response; #214 imported replies read responded", async () => {
    // The documented fallback: no response recorded → needs_response. The
    // seed's imported owner replies (existingReply fixtures) are the only
    // responses rows at this point — they flip exactly those reviews.
    expect(IMPORTED_REPLY_FIXTURES.length).toBeGreaterThan(0);
    const responded = importedReplyIds();
    const items = await collectAllPages({ practiceId: DEMO_PRACTICE_ID });
    for (const item of items) {
      expect(item.status).toBe(
        responded.has(item.id) ? "responded" : "needs_response",
      );
    }
  });

  it("scopes to the practice", async () => {
    const other = await practiceFactory(t.db);
    const page = await listReviewInbox(t.db, { practiceId: other.id });
    expect(page.items).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });
});

describe("listReviewInbox — filters (integration)", () => {
  it("filters by source", async () => {
    const google = await collectAllPages({
      practiceId: DEMO_PRACTICE_ID,
      filters: { source: "google" },
    });
    expect(google).toHaveLength(
      REVIEW_FIXTURES.filter((f) => f.sourceKind === "google").length,
    );
    for (const item of google) {
      expect(item.sourceKind).toBe("google");
    }
  });

  it("filters by location", async () => {
    const north = LOCATION_FIXTURES.find((l) => l.key === "north");
    if (!north) throw new Error("north location fixture missing");
    const items = await collectAllPages({
      practiceId: DEMO_PRACTICE_ID,
      filters: { locationId: seedId("location:north") },
    });
    expect(items).toHaveLength(
      REVIEW_FIXTURES.filter((f) => f.location === "north").length,
    );
  });

  it("filters by rating, multi-select", async () => {
    const lowRated = await collectAllPages({
      practiceId: DEMO_PRACTICE_ID,
      filters: { ratings: [1, 2] },
    });
    const expected = REVIEW_FIXTURES.filter(
      (f) => f.rating === "1.0" || f.rating === "2.0",
    );
    expect(new Set(lowRated.map((i) => i.id))).toEqual(
      new Set(expected.map((f) => signalId(f.key))),
    );
  });

  it("filters by sentiment, including unclassified", async () => {
    const negative = await collectAllPages({
      practiceId: DEMO_PRACTICE_ID,
      filters: { sentiment: "negative" },
    });
    expect(negative).toHaveLength(
      REVIEW_FIXTURES.filter((f) => effectiveSentiment(f) === "negative")
        .length,
    );

    // Every seeded review carries a sentiment derivation, so a factory row
    // without one proves the unclassified branch.
    const bare = await signalFactory(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      sourceKind: "manual",
      visibility: "public",
      originalText: "Walk-in review typed by staff, not yet classified.",
    });
    const unclassified = await collectAllPages({
      practiceId: DEMO_PRACTICE_ID,
      filters: { sentiment: "unclassified" },
    });
    expect(unclassified.map((i) => i.id)).toContain(bare.id);
    for (const item of unclassified) {
      expect(item.sentiment).toBeNull();
    }
  });

  it("filters by status honestly: needs_response and the #214 imported replies are non-empty today", async () => {
    const needs = await listReviewInbox(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      filters: { status: "needs_response" },
      limit: 5,
    });
    expect(needs.items.length).toBeGreaterThan(0);

    // Imported published replies count as responded (#214 requirement 3).
    const responded = await collectAllPages({
      practiceId: DEMO_PRACTICE_ID,
      filters: { status: "responded" },
    });
    expect(new Set(responded.map((i) => i.id))).toEqual(importedReplyIds());

    for (const status of ["drafted", "pending_approval"] as const) {
      const page = await listReviewInbox(t.db, {
        practiceId: DEMO_PRACTICE_ID,
        filters: { status },
      });
      expect(page.items).toHaveLength(0);
    }
  });

  it("ANDs filters together", async () => {
    const items = await collectAllPages({
      practiceId: DEMO_PRACTICE_ID,
      filters: { source: "google", ratings: [5], sentiment: "positive" },
    });
    const expected = REVIEW_FIXTURES.filter(
      (f) =>
        f.sourceKind === "google" &&
        f.rating === "5.0" &&
        effectiveSentiment(f) === "positive",
    );
    expect(items).toHaveLength(expected.length);
  });
});

describe("listReviewInbox — needs-attention-first ordering (integration)", () => {
  it("orders the seeded corpus negative-oldest-first, then mixed, then rest-newest, responded last", async () => {
    const items = await collectAllPages({ practiceId: DEMO_PRACTICE_ID });

    const tierOf = (item: ReviewInboxItem): number => {
      // The #214 imported replies land in the responded tier (5).
      if (item.status === "responded") return 5;
      const negative = isNegativeReview({
        rating: item.rating === null ? null : Number(item.rating),
        sentiment:
          item.sentiment === null
            ? null
            : (item.sentiment.value as "positive" | "mixed" | "negative"),
      });
      if (negative) return 1;
      if (item.sentiment?.value === "mixed") return 2;
      return 3;
    };

    let previousTier = 0;
    for (const item of items) {
      const tier = tierOf(item);
      expect(tier).toBeGreaterThanOrEqual(previousTier);
      previousTier = tier;
    }

    // Within tier 1: oldest first. Within tier 3: newest first.
    const tier1 = items.filter((i) => tierOf(i) === 1);
    for (let i = 1; i < tier1.length; i++) {
      expect(tier1[i]!.occurredAt.getTime()).toBeGreaterThanOrEqual(
        tier1[i - 1]!.occurredAt.getTime(),
      );
    }
    const tier3 = items.filter((i) => tierOf(i) === 3);
    for (let i = 1; i < tier3.length; i++) {
      expect(tier3[i]!.occurredAt.getTime()).toBeLessThanOrEqual(
        tier3[i - 1]!.occurredAt.getTime(),
      );
    }

    // Tier 5 (responded — the imported replies), newest first: g14 (17d)
    // before g16 (52d).
    const tier5 = items.filter((i) => tierOf(i) === 5);
    expect(tier5.map((i) => i.id)).toEqual([signalId("g14"), signalId("g16")]);
  });

  it("orders a hand-built fixture set exactly (tiers 1–3, both directions)", async () => {
    const p = await practiceFactory(t.db);
    const day = 24 * 60 * 60 * 1000;
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day);
    const review = (
      overrides: Partial<Parameters<typeof signalFactory>[1]> = {},
    ) =>
      signalFactory(t.db, {
        practiceId: p.id,
        sourceKind: "manual",
        visibility: "public",
        ...overrides,
      });

    // Tier 1 (negative), oldest first: A (100d) before B (50d).
    const a = await review({ originalRating: "1.0", occurredAt: at(100) });
    const b = await review({ occurredAt: at(50) }); // unrated + negative sentiment
    await derivationFactory(t.db, {
      signalId: b.id,
      dimension: "sentiment",
      value: "negative",
    });
    // Tier 2 (mixed), oldest first: C (80d) before D (40d).
    const c = await review({ occurredAt: at(80) });
    await derivationFactory(t.db, {
      signalId: c.id,
      dimension: "sentiment",
      value: "mixed",
    });
    const d = await review({ occurredAt: at(40), originalRating: "3.0" });
    await derivationFactory(t.db, {
      signalId: d.id,
      dimension: "sentiment",
      value: "mixed",
    });
    // Tier 3 (rest), newest first: E (10d) before F (90d).
    const e = await review({ occurredAt: at(10), originalRating: "5.0" });
    await derivationFactory(t.db, {
      signalId: e.id,
      dimension: "sentiment",
      value: "positive",
    });
    const f = await review({ occurredAt: at(90), originalRating: "4.0" });
    // Excluded: private review-kind, public non-review-kind.
    await review({ visibility: "private" });
    await review({ sourceKind: "email", sourceId: `email-${p.id}` });

    const page = await listReviewInbox(t.db, { practiceId: p.id });
    expect(page.items.map((i) => i.id)).toEqual([
      a.id,
      b.id,
      c.id,
      d.id,
      e.id,
      f.id,
    ]);
    // Tiers 4–5 need responses rows — see the module-doc note (#80).
  });

  it("a manual negative re-classification outranks an inferred positive (tier 1)", async () => {
    const p = await practiceFactory(t.db);
    const s = await signalFactory(t.db, {
      practiceId: p.id,
      sourceKind: "manual",
      visibility: "public",
      originalRating: "4.0",
      occurredAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });
    await derivationFactory(t.db, {
      signalId: s.id,
      dimension: "sentiment",
      value: "positive",
      basis: "inferred_text",
    });
    await derivationFactory(t.db, {
      signalId: s.id,
      dimension: "sentiment",
      value: "negative",
      basis: "manual",
    });
    const other = await signalFactory(t.db, {
      practiceId: p.id,
      sourceKind: "manual",
      visibility: "public",
      originalRating: "5.0",
      occurredAt: new Date(),
    });

    const page = await listReviewInbox(t.db, { practiceId: p.id });
    // The manually-negative review leads despite its 4-star rating.
    expect(page.items.map((i) => i.id)).toEqual([s.id, other.id]);
    expect(page.items[0]?.sentiment).toMatchObject({
      value: "negative",
      basis: "manual",
    });
  });

  it("sort=newest overrides with plain recency", async () => {
    const items = await collectAllPages({
      practiceId: DEMO_PRACTICE_ID,
      sort: "newest",
    });
    for (let i = 1; i < items.length; i++) {
      expect(items[i]!.occurredAt.getTime()).toBeLessThanOrEqual(
        items[i - 1]!.occurredAt.getTime(),
      );
    }
  });
});

describe("listReviewInbox — cursor pagination (integration)", () => {
  it("walks the full corpus in small pages without dupes or gaps across tier boundaries", async () => {
    const all = await collectAllPages({ practiceId: DEMO_PRACTICE_ID });
    const paged = await collectAllPages({ practiceId: DEMO_PRACTICE_ID }, 7);
    expect(paged.map((i) => i.id)).toEqual(all.map((i) => i.id));
    expect(new Set(paged.map((i) => i.id)).size).toBe(paged.length);
  });

  it("treats a malformed or wrong-mode cursor as page one", async () => {
    expect(decodeReviewsCursor("not-a-cursor", "attention")).toBeNull();
    expect(decodeReviewsCursor(undefined, "attention")).toBeNull();

    const first = await listReviewInbox(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      limit: 3,
    });
    // A cursor minted under "attention" must not apply to "newest".
    expect(decodeReviewsCursor(first.nextCursor, "newest")).toBeNull();
    const garbled = await listReviewInbox(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      cursor: "@@@@",
      limit: 3,
    });
    expect(garbled.items.map((i) => i.id)).toEqual(
      first.items.map((i) => i.id),
    );
  });
});

describe("countReviewInboxStatuses (integration)", () => {
  it("counts the corpus: needs_response plus the #214 imported replies as responded", async () => {
    const counts = await countReviewInboxStatuses(t.db, {
      practiceId: DEMO_PRACTICE_ID,
    });
    // + the unclassified factory review added above; assert via the list.
    const all = await collectAllPages({ practiceId: DEMO_PRACTICE_ID });
    expect(counts.total).toBe(all.length);
    expect(counts.needs_response).toBe(
      all.length - IMPORTED_REPLY_FIXTURES.length,
    );
    expect(counts.drafted).toBe(0);
    expect(counts.pending_approval).toBe(0);
    expect(counts.responded).toBe(IMPORTED_REPLY_FIXTURES.length);
  });

  it("respects the non-status filters", async () => {
    const counts = await countReviewInboxStatuses(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      filters: { ratings: [1, 2] },
    });
    const expected = REVIEW_FIXTURES.filter(
      (f) => f.rating === "1.0" || f.rating === "2.0",
    ).length;
    expect(counts.total).toBe(expected);
    expect(counts.needs_response).toBe(expected);
  });
});

describe("getReviewDetail (integration)", () => {
  it("assembles the detail for a seeded review", async () => {
    const fixture = REVIEW_FIXTURES.find((f) => f.key === "g01");
    if (!fixture) throw new Error("g01 fixture missing");
    const detail = await getReviewDetail(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      signalId: signalId("g01"),
    });
    expect(detail).toBeDefined();
    if (!detail) return;
    expect(detail.currentText).toBe(fixture.text);
    expect(detail.currentRating).toBe(fixture.rating);
    expect(detail.signal.sourceKind).toBe("google");
    expect(detail.locationName).not.toBeNull();
    expect(detail.providerName).not.toBeNull();
    // Current derivations resolve per dimension, with basis + confidence.
    expect(detail.currentDerivations.sentiment).toMatchObject({
      value: effectiveSentiment(fixture),
    });
    expect(detail.currentDerivations.response_risk).toBeDefined();
    // The response seam: no rows until #80's table lands.
    expect(detail.responses).toEqual([]);
    expect(detail.status).toBe("needs_response");
  });

  it("reads missing, cross-practice, private, and non-review identically as absent", async () => {
    const other = await practiceFactory(t.db);
    // Missing.
    expect(
      await getReviewDetail(t.db, {
        practiceId: DEMO_PRACTICE_ID,
        signalId: "00000000-0000-4000-8000-000000000000",
      }),
    ).toBeUndefined();
    // Cross-practice.
    expect(
      await getReviewDetail(t.db, {
        practiceId: other.id,
        signalId: signalId("g01"),
      }),
    ).toBeUndefined();
    // Private review-kind signal (the seeded CSV rows are private).
    const privateFixture = SIGNAL_FIXTURES.find(
      (f) => f.sourceKind === "csv_import" && f.visibility === "private",
    );
    if (!privateFixture) throw new Error("private csv fixture missing");
    expect(
      await getReviewDetail(t.db, {
        practiceId: DEMO_PRACTICE_ID,
        signalId: signalId(privateFixture.key),
      }),
    ).toBeUndefined();
    // Public but non-review source kind.
    const publicEmail = await signalFactory(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      sourceKind: "email",
      sourceId: "email-public-detail-test",
      visibility: "public",
    });
    expect(
      await getReviewDetail(t.db, {
        practiceId: DEMO_PRACTICE_ID,
        signalId: publicEmail.id,
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #80: response-status derivation from REAL `responses` rows. Keep this
// block LAST — it seeds rows onto the demo corpus, and the tests above pin
// the no-responses fallback.
// ---------------------------------------------------------------------------

describe("response-status derivation from responses rows (#80)", () => {
  const target = () => signalId("g01");

  it("the latest responses row drives the inbox status, step by step", async () => {
    const author = await staffMemberFactory(t.db, {
      practiceId: DEMO_PRACTICE_ID,
    });
    const statusOf = async () => {
      const items = await collectAllPages({ practiceId: DEMO_PRACTICE_ID });
      return items.find((i) => i.id === target())?.status;
    };

    await responseFactory(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      signalId: target(),
      authorId: author.id,
      status: "draft",
      body: "Draft one.",
      rejectionComment: "Please soften the tone.",
      createdAt: new Date("2026-07-01T00:00:00Z"),
    });
    expect(await statusOf()).toBe("drafted");

    await responseFactory(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      signalId: target(),
      authorId: author.id,
      status: "pending_approval",
      body: "Pending wording.",
      createdAt: new Date("2026-07-02T00:00:00Z"),
    });
    expect(await statusOf()).toBe("pending_approval");

    // approved-but-unpublished and publish-failed are still inside the
    // human gate — never "responded" (#76's strict definition).
    await responseFactory(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      signalId: target(),
      authorId: author.id,
      status: "failed",
      body: "Failed wording.",
      errorDetail: {
        kind: "transient_exhausted",
        message: "HTTP 503",
        at: "2026-07-03T00:00:00.000Z",
      },
      createdAt: new Date("2026-07-03T00:00:00Z"),
    });
    expect(await statusOf()).toBe("pending_approval");

    await responseFactory(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      signalId: target(),
      authorId: author.id,
      status: "published",
      body: "Published wording.",
      publishedAt: new Date("2026-07-04T00:00:00Z"),
      moderationState: "PENDING",
      createdAt: new Date("2026-07-04T00:00:00Z"),
    });
    expect(await statusOf()).toBe("responded");
  });

  it("status filter and counts read through the same derivation", async () => {
    const responded = await collectAllPages({
      practiceId: DEMO_PRACTICE_ID,
      filters: { status: "responded" },
    });
    // Newest first within the responded tier: g01 (12d) leads the seeded
    // #214 imports g14 (17d) and g16 (52d).
    expect(responded.map((i) => i.id)).toEqual([
      target(),
      signalId("g14"),
      signalId("g16"),
    ]);

    const counts = await countReviewInboxStatuses(t.db, {
      practiceId: DEMO_PRACTICE_ID,
    });
    expect(counts.responded).toBe(1 + IMPORTED_REPLY_FIXTURES.length);
  });

  it("responded reviews sort into the last tier", async () => {
    const items = await collectAllPages({ practiceId: DEMO_PRACTICE_ID });
    expect(items.slice(-3).map((i) => i.id)).toEqual([
      target(),
      signalId("g14"),
      signalId("g16"),
    ]);
  });

  it("getReviewDetail assembles the populated thread, newest first", async () => {
    const detail = await getReviewDetail(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      signalId: target(),
    });
    expect(detail).toBeDefined();
    if (!detail) return;

    expect(detail.status).toBe("responded");
    expect(detail.responses.map((r) => r.status)).toEqual([
      "published",
      "failed",
      "pending_approval",
      "draft",
    ]);
    const [published, failed, , draft] = detail.responses;
    expect(published?.publishedAt).not.toBeNull();
    expect(published?.publishedUrl).toBe(detail.signal.sourceUrl);
    expect(published?.moderationState).toBe("PENDING");
    expect(published?.authorName).not.toBeNull();
    expect(failed?.errorDetail).toMatchObject({ kind: "transient_exhausted" });
    expect(draft?.rejectionComment).toBe("Please soften the tone.");
  });
});
