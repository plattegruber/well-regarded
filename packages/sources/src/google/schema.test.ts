/**
 * Drift guard between the adapter's zod schema (./schema.ts) and the fake
 * GBP server (#130) — the shared source of recorded shapes (issue #125
 * requirement 3). Every review the fake generator can produce, and every
 * recorded fixture page, must parse; if the fake's wire types gain a field
 * the schema chokes on, this fails here instead of in an import run.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FIXTURE_EPOCH, generateFixturePractice } from "./fake/fixtures.js";
import { FakeGbpStore } from "./fake/store.js";
import { gbpReviewSchema, gbpReviewsPageSchema } from "./schema.js";

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(`${fixturesDir}${name}`, "utf8"));
}

describe("google payload schema ↔ fake server (#130) drift guard", () => {
  it("parses every recorded reviews fixture page", async () => {
    for (const name of [
      "reviews.list.page1.json",
      "reviews.list.page2.json",
      "reviews.list.empty.json",
    ]) {
      const page = await loadFixture(name);
      expect(gbpReviewsPageSchema.safeParse(page).success, name).toBe(true);
    }
  });

  it("parses every review the fake generator produces (full quirk matrix)", () => {
    const store = new FakeGbpStore({ clock: () => Date.parse(FIXTURE_EPOCH) });
    const { reviews } = generateFixturePractice(store, {
      locations: 2,
      reviewsPerLocation: 15,
      seed: 7,
    });
    expect(reviews.length).toBeGreaterThan(0);
    for (const review of reviews) {
      const parsed = gbpReviewSchema.safeParse(review);
      expect(parsed.success, review.name).toBe(true);
    }
  });

  it("preserves unknown fields instead of rejecting them (ADR 0002 #125 adjustment)", () => {
    const page = gbpReviewsPageSchema.parse({
      reviews: [],
      fieldGoogleShipsNextYear: { anything: true },
    });
    expect(page).toMatchObject({
      fieldGoogleShipsNextYear: { anything: true },
    });
  });
});
