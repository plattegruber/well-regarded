import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { renderGoogleFixtureFiles } from "./fixtureFiles.js";
import { FIXTURE_EPOCH, generateFixturePractice } from "./fixtures.js";
import { FakeGbpStore } from "./store.js";

function generate(seed: number, reviewsPerLocation = 15) {
  const store = new FakeGbpStore({ clock: () => Date.parse(FIXTURE_EPOCH) });
  const practice = generateFixturePractice(store, {
    seed,
    locations: 2,
    reviewsPerLocation,
  });
  return { store, practice };
}

describe("generateFixturePractice", () => {
  it("is deterministic: same seed ⇒ byte-identical data", () => {
    const a = generate(7).practice;
    const b = generate(7).practice;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("different seeds produce different data", () => {
    expect(JSON.stringify(generate(1).practice.reviews)).not.toBe(
      JSON.stringify(generate(2).practice.reviews),
    );
  });

  it("builds the requested shape with full v4 resource names", () => {
    const { practice } = generate(42);
    expect(practice.locations).toHaveLength(2);
    expect(practice.reviews).toHaveLength(30);
    expect(practice.account.name).toBe("accounts/1");
    for (const review of practice.reviews) {
      expect(review.name).toMatch(
        /^accounts\/1\/locations\/[12]\/reviews\/\d+$/,
      );
    }
  });

  it("covers the quirk matrix in every location, even at the minimum size", () => {
    const { practice } = generate(3, 6);
    for (const location of practice.locations) {
      const locationId = location.name.split("/")[1];
      const reviews = practice.reviews.filter((r) =>
        r.name.startsWith(`accounts/1/locations/${locationId}/`),
      );
      expect(reviews).toHaveLength(6);

      // star-only: rated, but no comment at all.
      expect(reviews.some((r) => !("comment" in r))).toBe(true);
      // edited: updateTime strictly after createTime (and not just from a reply).
      expect(
        reviews.some(
          (r) => !r.reviewReply && r.updateTime.localeCompare(r.createTime) > 0,
        ),
      ).toBe(true);
      // replies in all three moderation states, rejection with a reason.
      const states = reviews
        .map((r) => r.reviewReply?.reviewReplyState)
        .filter((s) => s !== undefined);
      expect(new Set(states)).toEqual(
        new Set(["APPROVED", "REJECTED", "PENDING"]),
      );
      const rejected = reviews.find(
        (r) => r.reviewReply?.reviewReplyState === "REJECTED",
      );
      expect(rejected?.reviewReply?.policyViolation).toMatch(/policy/i);
      // anonymized reviewer.
      expect(
        reviews.some(
          (r) =>
            r.reviewer.isAnonymous === true &&
            r.reviewer.displayName === "A Google user",
        ),
      ).toBe(true);
    }
  });

  it("keeps timestamps sane: createTime ≤ updateTime ≤ fixture epoch", () => {
    const { practice } = generate(42);
    for (const review of practice.reviews) {
      expect(
        review.createTime.localeCompare(review.updateTime),
      ).toBeLessThanOrEqual(0);
      expect(
        review.updateTime.localeCompare(FIXTURE_EPOCH),
      ).toBeLessThanOrEqual(0);
      if (review.reviewReply) {
        expect(
          review.reviewReply.updateTime.localeCompare(review.updateTime),
        ).toBeLessThanOrEqual(0);
      }
    }
  });

  it("fills Presence profile fields on every location (#156)", () => {
    const { practice, store } = generate(42);
    for (const location of practice.locations) {
      expect(location.regularHours?.periods.length).toBeGreaterThan(0);
      expect(location.websiteUri).toMatch(/^https:\/\//);
      expect(location.categories?.primaryCategory.name).toBe(
        "categories/gcid:dentist",
      );
      expect(location.storefrontAddress?.regionCode).toBe("US");
      expect(location.metadata?.hasVoiceOfMerchant).toBe(true);
    }
    expect(store.mediaItemCount("1", "1")).toBeGreaterThan(0);
  });
});

describe("recorded-shape fixture files (src/google/fixtures)", () => {
  it("match what the fake server serves — regenerate with `pnpm --filter @wellregarded/sources gen:google-fixtures`", async () => {
    const rendered = await renderGoogleFixtureFiles();
    const dir = fileURLToPath(new URL("../fixtures/", import.meta.url));
    const onDisk = (await readdir(dir)).filter((f) => f.endsWith(".json"));

    expect(onDisk.sort()).toEqual(Object.keys(rendered).sort());
    for (const [name, content] of Object.entries(rendered)) {
      expect(await readFile(`${dir}${name}`, "utf8"), name).toBe(content);
    }
  });

  it("rendering is itself deterministic", async () => {
    const first = await renderGoogleFixtureFiles();
    const second = await renderGoogleFixtureFiles();
    expect(second).toEqual(first);
  });
});
