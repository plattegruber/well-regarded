import { describe, expect, it } from "vitest";

import { insertTemplateBody } from "./template-insert";

const PRACTICE = "Cedar Ridge Dental";

describe("insertTemplateBody", () => {
  it("substitutes both placeholders when the reviewer is known", () => {
    const result = insertTemplateBody(
      "Thank you, {reviewer_name} — the {practice_name} team.",
      { reviewerName: "Jordan", practiceName: PRACTICE },
    );
    expect(result.text).toBe(
      "Thank you, Jordan — the Cedar Ridge Dental team.",
    );
    expect(result.cursor).toBe(result.text.length);
  });

  it("removes the vocative-comma greeting cleanly for anonymous reviewers", () => {
    const result = insertTemplateBody(
      "Thank you so much for the kind words, {reviewer_name}. Reviews mean a lot to us at {practice_name}.",
      { reviewerName: null, practiceName: PRACTICE },
    );
    expect(result.text).toBe(
      "Thank you so much for the kind words. Reviews mean a lot to us at Cedar Ridge Dental.",
    );
    // The caret sits where the name would have gone.
    expect(result.cursor).toBe("Thank you so much for the kind words".length);
  });

  it("removes a space-preceded token and points the cursor there", () => {
    const result = insertTemplateBody("Hello {reviewer_name} and welcome.", {
      reviewerName: null,
      practiceName: PRACTICE,
    });
    expect(result.text).toBe("Hello and welcome.");
    expect(result.cursor).toBe("Hello".length);
  });

  it("handles a token at the very start", () => {
    const result = insertTemplateBody("{reviewer_name}, thank you.", {
      reviewerName: null,
      practiceName: PRACTICE,
    });
    expect(result.text).toBe(", thank you.");
    expect(result.cursor).toBe(0);
  });

  it("removes every occurrence; cursor marks the first", () => {
    const result = insertTemplateBody(
      "Thanks, {reviewer_name}. Truly, {reviewer_name}.",
      { reviewerName: null, practiceName: PRACTICE },
    );
    expect(result.text).toBe("Thanks. Truly.");
    expect(result.cursor).toBe("Thanks".length);
  });

  it("leaves bodies without the token untouched (cursor at end)", () => {
    const result = insertTemplateBody(
      "Thank you for taking the time to leave a rating.",
      { reviewerName: null, practiceName: PRACTICE },
    );
    expect(result.text).toBe(
      "Thank you for taking the time to leave a rating.",
    );
    expect(result.cursor).toBe(result.text.length);
  });

  it("leaves unknown placeholders literal — honesty over guessing", () => {
    const result = insertTemplateBody(
      "On {appointment_date} at {practice_name}.",
      {
        reviewerName: "Jordan",
        practiceName: PRACTICE,
      },
    );
    expect(result.text).toBe("On {appointment_date} at Cedar Ridge Dental.");
  });
});
