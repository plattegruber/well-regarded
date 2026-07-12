import { describe, expect, it } from "vitest";

import {
  countWords,
  EXCERPT_MIN_MODEL_WORDS,
  EXCERPTS_PROMPT_NAME,
  excerptsPrompt,
  excerptsRetryPrompt,
  locateExcerpt,
  validateExcerpts,
  wholeTextExcerpt,
} from "./excerpts.js";

const REVIEW =
  "Dr. Patel was gentle and explained every step before doing it. " +
  "The billing was confusing and nobody could tell me what I owed. " +
  "Parking out front is terrible.";

describe("locateExcerpt — the verbatim-substring validator", () => {
  it("accepts an exact substring and returns its offset", () => {
    const excerpt =
      "The billing was confusing and nobody could tell me what I owed.";
    const located = locateExcerpt(REVIEW, excerpt);
    expect(located).not.toBeNull();
    expect(located?.text).toBe(excerpt);
    expect(located?.startOffset).toBe(REVIEW.indexOf(excerpt));
    // The slice invariant every accepted excerpt must satisfy.
    expect(
      REVIEW.slice(
        located?.startOffset,
        (located?.startOffset ?? 0) + (located?.text.length ?? 0),
      ),
    ).toBe(excerpt);
  });

  it("accepts a match where the model normalized curly quotes, storing the ORIGINAL characters", () => {
    const original = "She said “come back Tuesday” and it wasn’t a problem.";
    // The model helpfully straightened the quotes.
    const located = locateExcerpt(
      original,
      `She said "come back Tuesday" and it wasn't a problem.`,
    );
    expect(located).not.toBeNull();
    expect(located?.startOffset).toBe(0);
    // Stored text is the exact original slice — curly quotes intact.
    expect(located?.text).toBe(original);
  });

  it("accepts a match where the model rewrapped whitespace, mapping back to original offsets", () => {
    const original =
      "Great cleaning.\n\nThe   hygienist was\tgentle throughout.";
    const located = locateExcerpt(
      original,
      "The hygienist was gentle throughout.",
    );
    expect(located).not.toBeNull();
    const startOffset = located?.startOffset ?? -1;
    expect(startOffset).toBe(original.indexOf("The   hygienist"));
    // The stored text is the original slice, internal whitespace and all.
    expect(located?.text).toBe("The   hygienist was\tgentle throughout.");
    expect(
      original.slice(startOffset, startOffset + (located?.text.length ?? 0)),
    ).toBe(located?.text);
  });

  it("rejects a paraphrase", () => {
    expect(
      locateExcerpt(REVIEW, "The doctor was kind and explained everything."),
    ).toBeNull();
  });

  it("rejects sentences merged from different places", () => {
    expect(
      locateExcerpt(
        REVIEW,
        "Dr. Patel was gentle and Parking out front is terrible.",
      ),
    ).toBeNull();
  });

  it("rejects a 'fixed typo' rewrite", () => {
    const original = "The recepshunist was super nice about rescheduling.";
    expect(
      locateExcerpt(
        original,
        "The receptionist was super nice about rescheduling.",
      ),
    ).toBeNull();
  });

  it("rejects empty and whitespace-only excerpts", () => {
    expect(locateExcerpt(REVIEW, "   ")).toBeNull();
  });
});

describe("validateExcerpts", () => {
  it("splits a mixed response into accepted (with offsets) and rejected", () => {
    const { accepted, rejected } = validateExcerpts(REVIEW, {
      excerpts: [
        {
          text: "Dr. Patel was gentle and explained every step before doing it.",
          topic_hint: "provider care",
        },
        {
          text: "Billing was a total mess from start to finish.",
          topic_hint: "billing",
        },
        { text: "Parking out front is terrible.", topic_hint: "parking" },
      ],
    });
    expect(accepted.map((excerpt) => excerpt.topicHint)).toEqual([
      "provider care",
      "parking",
    ]);
    expect(accepted[0]?.startOffset).toBe(0);
    expect(accepted[1]?.startOffset).toBe(REVIEW.indexOf("Parking"));
    expect(rejected).toEqual([
      "Billing was a total mess from start to finish.",
    ]);
  });

  it("collapses duplicate spans to one row", () => {
    const { accepted } = validateExcerpts(REVIEW, {
      excerpts: [
        { text: "Parking out front is terrible.", topic_hint: "parking" },
        { text: "Parking out front is terrible.", topic_hint: "parking again" },
      ],
    });
    expect(accepted).toHaveLength(1);
  });
});

describe("wholeTextExcerpt — the <15-word short-circuit", () => {
  it("returns the trimmed whole text with the offset past leading whitespace", () => {
    const excerpt = wholeTextExcerpt("  Quick visit, no complaints.\n");
    expect(excerpt).toEqual({
      text: "Quick visit, no complaints.",
      startOffset: 2,
      topicHint: null,
    });
  });

  it("countWords gates the model call at 15 words", () => {
    expect(EXCERPT_MIN_MODEL_WORDS).toBe(15);
    expect(countWords("one two three")).toBe(3);
    expect(countWords("  spaced\t\tout   words \n here ")).toBe(4);
  });
});

describe("prompt construction", () => {
  it("keeps the prompt name constant and wraps the text in <signal>", () => {
    const prompt = excerptsPrompt({ text: REVIEW });
    expect(prompt.name).toBe(EXCERPTS_PROMPT_NAME);
    expect(prompt.system).toContain("verbatim, character-for-character");
    expect(prompt.user).toContain(`<signal>\n${REVIEW}\n</signal>`);
  });

  it("the retry prompt keeps the same name and lists the violations", () => {
    const retry = excerptsRetryPrompt({ text: REVIEW }, ["a fabricated one"]);
    expect(retry.name).toBe(EXCERPTS_PROMPT_NAME);
    expect(retry.user).toContain('"a fabricated one"');
    expect(retry.user).toContain("NOT exact substrings");
  });
});
