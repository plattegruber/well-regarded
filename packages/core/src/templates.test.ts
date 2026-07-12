import { describe, expect, it } from "vitest";

import {
  lintTemplateBody,
  renderTemplate,
  responseTemplateSchema,
  STARTER_RESPONSE_TEMPLATES,
  TEMPLATE_PLACEHOLDERS,
} from "./templates.js";

describe("renderTemplate", () => {
  it("substitutes both whitelisted placeholders", () => {
    expect(
      renderTemplate("Thanks, {reviewer_name} — from {practice_name}.", {
        reviewer_name: "Jordan",
        practice_name: "Cedar Ridge Dental",
      }),
    ).toBe("Thanks, Jordan — from Cedar Ridge Dental.");
  });

  it("substitutes repeated occurrences", () => {
    expect(
      renderTemplate("{practice_name} is {practice_name}.", {
        practice_name: "Cedar Ridge",
      }),
    ).toBe("Cedar Ridge is Cedar Ridge.");
  });

  it("substitutes an explicit empty string (anonymous reviewer)", () => {
    expect(
      renderTemplate("Thanks, {reviewer_name}.", { reviewer_name: "" }),
    ).toBe("Thanks, .");
  });

  it("leaves whitelisted placeholders literal when no value is provided", () => {
    expect(renderTemplate("Thanks, {reviewer_name}.", {})).toBe(
      "Thanks, {reviewer_name}.",
    );
  });

  it("leaves unknown placeholders literal — rendering never invents content", () => {
    expect(
      renderTemplate("Your {last_visit_date} visit at {practice_name}.", {
        practice_name: "Cedar Ridge",
      }),
    ).toBe("Your {last_visit_date} visit at Cedar Ridge.");
  });

  it("ignores non-placeholder braces", () => {
    expect(renderTemplate("A {not a placeholder} stays.", {})).toBe(
      "A {not a placeholder} stays.",
    );
  });
});

describe("lintTemplateBody", () => {
  it("accepts a body using only whitelisted placeholders", () => {
    const result = lintTemplateBody(
      "Thank you, {reviewer_name} — the {practice_name} team.",
    );
    expect(result.unknownPlaceholders).toEqual([]);
    expect(result.usedPlaceholders.sort()).toEqual(
      [...TEMPLATE_PLACEHOLDERS].sort(),
    );
  });

  it("reports unknown placeholders, deduplicated", () => {
    const result = lintTemplateBody(
      "On {appointment_date} your {procedure} — {appointment_date}.",
    );
    expect(result.unknownPlaceholders.sort()).toEqual([
      "appointment_date",
      "procedure",
    ]);
  });

  it("reports nothing for a placeholder-free body", () => {
    const result = lintTemplateBody("Thank you for the feedback.");
    expect(result.unknownPlaceholders).toEqual([]);
    expect(result.usedPlaceholders).toEqual([]);
  });
});

describe("responseTemplateSchema", () => {
  it("accepts a valid template and trims", () => {
    const parsed = responseTemplateSchema.parse({
      name: "  Positive review ",
      body: " Thank you. ",
      tone: "warm",
    });
    expect(parsed).toEqual({
      name: "Positive review",
      body: "Thank you.",
      tone: "warm",
    });
  });

  it("rejects an empty name and an unknown tone", () => {
    const result = responseTemplateSchema.safeParse({
      name: "  ",
      body: "Thanks.",
      tone: "sassy",
    });
    expect(result.success).toBe(false);
  });
});

describe("STARTER_RESPONSE_TEMPLATES", () => {
  it("ships exactly four, with unique keys and names", () => {
    expect(STARTER_RESPONSE_TEMPLATES).toHaveLength(4);
    const keys = STARTER_RESPONSE_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(4);
  });

  it("every body lints clean and passes the boundary schema", () => {
    for (const template of STARTER_RESPONSE_TEMPLATES) {
      expect(lintTemplateBody(template.body).unknownPlaceholders).toEqual([]);
      expect(
        responseTemplateSchema.safeParse({
          name: template.name,
          body: template.body,
          tone: template.tone,
        }).success,
      ).toBe(true);
    }
  });

  it("stays on-voice: no exclamation points, no emoji", () => {
    for (const template of STARTER_RESPONSE_TEMPLATES) {
      expect(template.body).not.toContain("!");
    }
  });
});
