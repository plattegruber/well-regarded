import { describe, expect, it } from "vitest";

import {
  type ComposerSafetyFinding,
  type ComposerSafetyResult,
  isFreshResult,
  segmentText,
  textHash,
} from "./safety-spans";

const finding = (
  overrides: Partial<ComposerSafetyFinding> = {},
): ComposerSafetyFinding => ({
  span: { start: 0, end: 4 },
  code: "appointment_detail",
  reason: "Names a specific date.",
  level: "block",
  ...overrides,
});

describe("textHash / isFreshResult", () => {
  it("is deterministic and sensitive to any edit", () => {
    expect(textHash("March 3rd")).toBe(textHash("March 3rd"));
    expect(textHash("March 3rd")).not.toBe(textHash("March 4th"));
    expect(textHash("")).toBe(textHash(""));
  });

  it("accepts a result only for the exact checked text", () => {
    const result: ComposerSafetyResult = {
      level: "block",
      findings: [finding()],
      checkedHash: textHash("Sorry about March 3rd."),
    };
    expect(isFreshResult(result, "Sorry about March 3rd.")).toBe(true);
    // The user typed since the debounce fired — stale spans are discarded.
    expect(isFreshResult(result, "Sorry about March 3rd. More")).toBe(false);
    expect(isFreshResult(undefined, "anything")).toBe(false);
  });
});

describe("segmentText", () => {
  it("returns nothing for empty text", () => {
    expect(segmentText("", [finding()])).toEqual([]);
  });

  it("splits around a single span, preserving every character", () => {
    const text = "Sorry about March 3rd, truly.";
    const start = text.indexOf("March");
    const segments = segmentText(text, [
      finding({ span: { start, end: start + "March 3rd".length } }),
    ]);
    expect(segments).toEqual([
      { text: "Sorry about ", level: null },
      { text: "March 3rd", level: "block" },
      { text: ", truly.", level: null },
    ]);
    expect(segments.map((s) => s.text).join("")).toBe(text);
  });

  it("resolves overlapping spans to the more severe level", () => {
    const text = "call 555-0100 on March 3";
    const segments = segmentText(text, [
      finding({ span: { start: 5, end: 13 }, level: "warn" }),
      finding({ span: { start: 5, end: 13 }, level: "block" }),
    ]);
    expect(segments).toEqual([
      { text: "call ", level: null },
      { text: "555-0100", level: "block" },
      { text: " on March 3", level: null },
    ]);
  });

  it("ignores whole-draft (span null) and info findings", () => {
    const text = "A perfectly ordinary reply.";
    const segments = segmentText(text, [
      finding({ span: null }),
      finding({ span: { start: 0, end: 5 }, level: "info" }),
    ]);
    expect(segments).toEqual([{ text, level: null }]);
  });

  it("clamps out-of-range spans and drops inverted ones", () => {
    const text = "short";
    expect(
      segmentText(text, [finding({ span: { start: 2, end: 99 } })]),
    ).toEqual([
      { text: "sh", level: null },
      { text: "ort", level: "block" },
    ]);
    expect(
      segmentText(text, [finding({ span: { start: 4, end: 2 } })]),
    ).toEqual([{ text, level: null }]);
  });

  it("merges adjacent same-level runs from abutting findings", () => {
    const text = "ab";
    const segments = segmentText(text, [
      finding({ span: { start: 0, end: 1 }, level: "warn" }),
      finding({ span: { start: 1, end: 2 }, level: "warn" }),
    ]);
    expect(segments).toEqual([{ text: "ab", level: "warn" }]);
  });
});
