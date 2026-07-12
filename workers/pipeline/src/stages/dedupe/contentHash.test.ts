import { describe, expect, it } from "vitest";

import { contentHash } from "./contentHash";

const base = {
  text: "Dr. Patel was wonderful with my daughter.",
  rating: "5.0",
  occurredAt: new Date("2026-03-02T14:30:00Z"),
};

describe("contentHash", () => {
  it("is deterministic for identical content", async () => {
    expect(await contentHash(base)).toBe(await contentHash({ ...base }));
  });

  it("changes when the text changes", async () => {
    expect(
      await contentHash({ ...base, text: `${base.text} (edited)` }),
    ).not.toBe(await contentHash(base));
  });

  it("changes when the rating changes", async () => {
    expect(await contentHash({ ...base, rating: "4.0" })).not.toBe(
      await contentHash(base),
    );
  });

  it("changes when occurredAt changes", async () => {
    expect(
      await contentHash({
        ...base,
        occurredAt: new Date("2026-03-02T14:30:01Z"),
      }),
    ).not.toBe(await contentHash(base));
  });

  it("distinguishes null text from empty string (no framing collisions)", async () => {
    expect(await contentHash({ ...base, text: null })).not.toBe(
      await contentHash({ ...base, text: "" }),
    );
  });

  it("distinguishes null rating from a rated zero", async () => {
    expect(await contentHash({ ...base, rating: null })).not.toBe(
      await contentHash({ ...base, rating: "0.0" }),
    );
  });

  it("treats equal instants in different offsets as the same content", async () => {
    expect(
      await contentHash({
        ...base,
        occurredAt: new Date("2026-03-02T09:30:00-05:00"),
      }),
    ).toBe(await contentHash(base));
  });
});
