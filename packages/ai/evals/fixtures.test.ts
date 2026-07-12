/**
 * Golden-set integrity tests (issue #73): every fixture line parses,
 * matches its schema, carries the current prompt version, and — for
 * excerpts — every expected span is a verbatim slice at its stated
 * offset. These run in `pnpm test` with no API key: they validate the
 * LABELS, not the model.
 */

import { describe, expect, it } from "vitest";

import { EXCERPTS_PROMPT_NAME } from "../src/prompts/excerpts.js";
import { JUDGMENTS_PROMPT_NAME } from "../src/prompts/judgments.js";
import { SAFETY_PROMPT_NAME } from "../src/prompts/safety.js";
import {
  loadExcerptsFixtures,
  loadJudgmentsFixtures,
  loadSafetyFixtures,
} from "./cases.js";

const MIN_CASES = 25;

describe("judgments golden set", () => {
  const fixtures = loadJudgmentsFixtures();

  it(`has at least ${MIN_CASES} cases labeled against the current prompt`, () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(MIN_CASES);
    for (const fixture of fixtures) {
      expect(fixture.prompt).toBe(JUDGMENTS_PROMPT_NAME);
    }
  });

  it("covers every urgency tier and all three sentiments", () => {
    const urgencies = new Set(fixtures.map((f) => f.expected.urgency));
    expect([...urgencies].sort()).toEqual(
      ["critical", "high", "low", "medium", "none"].sort(),
    );
    const sentiments = new Set(fixtures.map((f) => f.expected.sentiment));
    expect([...sentiments].sort()).toEqual(["mixed", "negative", "positive"]);
  });

  it("includes the required edge cases: rating-only, non-English, sarcasm", () => {
    expect(fixtures.some((f) => f.input.text === "")).toBe(true);
    expect(fixtures.some((f) => f.id.startsWith("spanish-"))).toBe(true);
    expect(fixtures.some((f) => f.id.includes("sarcasm"))).toBe(true);
  });
});

describe("excerpts golden set", () => {
  const fixtures = loadExcerptsFixtures();

  it(`has at least ${MIN_CASES} cases labeled against the current prompt`, () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(MIN_CASES);
    for (const fixture of fixtures) {
      expect(fixture.prompt).toBe(EXCERPTS_PROMPT_NAME);
    }
  });

  it("every expected excerpt is the verbatim slice at its stated offset", () => {
    for (const fixture of fixtures) {
      for (const excerpt of fixture.expected.excerpts) {
        const slice = fixture.input.text.slice(
          excerpt.start_offset,
          excerpt.start_offset + excerpt.text.length,
        );
        expect(slice, `${fixture.id}: "${excerpt.text}"`).toBe(excerpt.text);
      }
    }
  });

  it("expected spans within a case never overlap", () => {
    for (const fixture of fixtures) {
      const spans = fixture.expected.excerpts
        .map((excerpt) => ({
          start: excerpt.start_offset,
          end: excerpt.start_offset + excerpt.text.length,
        }))
        .sort((a, b) => a.start - b.start);
      for (let i = 1; i < spans.length; i++) {
        const previous = spans[i - 1];
        const current = spans[i];
        if (!previous || !current) continue;
        expect(
          current.start,
          `${fixture.id}: spans overlap`,
        ).toBeGreaterThanOrEqual(previous.end);
      }
    }
  });
});

describe("safety golden set", () => {
  const fixtures = loadSafetyFixtures();

  it(`has at least ${MIN_CASES} cases labeled against the current prompt`, () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(MIN_CASES);
    for (const fixture of fixtures) {
      expect(fixture.prompt).toBe(SAFETY_PROMPT_NAME);
    }
  });

  it("every must_block case expects level block, and all three levels appear", () => {
    for (const fixture of fixtures) {
      if (fixture.expected.must_block) {
        expect(fixture.expected.level, fixture.id).toBe("block");
      }
    }
    const levels = new Set(fixtures.map((f) => f.expected.level));
    expect([...levels].sort()).toEqual(["block", "ok", "warn"]);
  });

  it("has must_block coverage (the zero-tolerance rule needs cases to bite on)", () => {
    const mustBlock = fixtures.filter((f) => f.expected.must_block);
    expect(mustBlock.length).toBeGreaterThanOrEqual(8);
  });
});
