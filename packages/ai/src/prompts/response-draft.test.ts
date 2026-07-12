import { describe, expect, it } from "vitest";

import { FakeAiProvider } from "../fake.js";
import {
  RESPONSE_DRAFT_MAX_CHARS,
  RESPONSE_DRAFT_PROMPT_NAME,
  RESPONSE_DRAFT_PURPOSE,
  ResponseDraftSchema,
  responseDraftPrompt,
} from "./response-draft.js";

const input = {
  reviewText: "Front desk was rude and the wait was endless.",
  rating: "2.0",
  practiceName: "Cedar Ridge Dental",
};

describe("ResponseDraftSchema", () => {
  it("accepts a short draft and rejects empty or over-long drafts", () => {
    expect(ResponseDraftSchema.parse({ draft: "Thank you." })).toEqual({
      draft: "Thank you.",
    });
    expect(ResponseDraftSchema.safeParse({ draft: "" }).success).toBe(false);
    expect(
      ResponseDraftSchema.safeParse({
        draft: "x".repeat(RESPONSE_DRAFT_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
  });
});

describe("responseDraftPrompt", () => {
  it("keeps the fixture key constant — never interpolated", () => {
    expect(responseDraftPrompt(input).name).toBe(RESPONSE_DRAFT_PROMPT_NAME);
    expect(
      responseDraftPrompt({ ...input, practiceName: "Elsewhere Dental" }).name,
    ).toBe(RESPONSE_DRAFT_PROMPT_NAME);
  });

  it("includes exactly the three allowed inputs: review text, rating, practice name", () => {
    const prompt = responseDraftPrompt(input);
    expect(prompt.user).toContain(input.reviewText);
    expect(prompt.user).toContain("2.0 out of 5");
    expect(prompt.user).toContain("Cedar Ridge Dental");
  });

  it("says so plainly for rating-only reviews", () => {
    const prompt = responseDraftPrompt({ ...input, reviewText: null });
    expect(prompt.user).toContain("(no text — rating only)");
    const blank = responseDraftPrompt({ ...input, reviewText: "   " });
    expect(blank.user).toContain("(no text — rating only)");
  });

  it("renders a missing rating as none", () => {
    expect(responseDraftPrompt({ ...input, rating: null }).user).toContain(
      "rating: none",
    );
  });

  it("carries the hard privacy rules in the system prompt", () => {
    const system = responseDraftPrompt(input).system ?? "";
    expect(system).toContain("Never confirm the reviewer was a patient");
    expect(system).toContain(
      "Their disclosure is not the practice's permission",
    );
    expect(system).toContain(
      "call our office and ask for our practice manager",
    );
    expect(system).toContain("No exclamation points");
  });
});

describe("with FakeAiProvider", () => {
  it("round-trips a schema-valid draft on the drafting lane", async () => {
    const provider = new FakeAiProvider({
      [RESPONSE_DRAFT_PROMPT_NAME]: [
        {
          draft:
            "We're sorry to hear the welcome fell short. Please call our office and ask for our practice manager — we'd like to make it right.",
        },
      ],
    });

    const result = await provider.classify(
      responseDraftPrompt(input),
      ResponseDraftSchema,
      {
        purpose: RESPONSE_DRAFT_PURPOSE,
        practiceId: "0f9619ff-8b86-4d01-b42d-00cf4fc964ff",
        model: "drafting",
      },
    );

    expect(result.value.draft).toContain("practice manager");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.model).toBe("fake-drafting");
    expect(provider.calls[0]?.opts.purpose).toBe(RESPONSE_DRAFT_PURPOSE);
  });

  it("rejects a fixture that violates the schema — fixtures cannot drift", async () => {
    const provider = new FakeAiProvider({
      [RESPONSE_DRAFT_PROMPT_NAME]: [{ draft: "" }],
    });
    await expect(
      provider.classify(responseDraftPrompt(input), ResponseDraftSchema, {
        purpose: RESPONSE_DRAFT_PURPOSE,
        practiceId: null,
        model: "drafting",
      }),
    ).rejects.toThrowError(/does not match the schema/);
  });
});
