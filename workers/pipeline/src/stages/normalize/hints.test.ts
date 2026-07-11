import { describe, expect, it } from "vitest";

import {
  type NamedEntity,
  normalizeEntityName,
  resolveEntityHint,
} from "./hints";

const patel: NamedEntity = {
  id: "prov-patel",
  names: ["Dr. Patel", "Dr. Anika Patel, DDS"],
};
const kim: NamedEntity = { id: "prov-kim", names: ["Dr. Kim", null] };
const entities = [patel, kim];

describe("normalizeEntityName", () => {
  it("collapses case and whitespace only", () => {
    expect(normalizeEntityName("  DR.   Patel ")).toBe("dr. patel");
    // No punctuation stripping: "Dr Patel" is NOT "Dr. Patel".
    expect(normalizeEntityName("Dr Patel")).not.toBe(
      normalizeEntityName("Dr. Patel"),
    );
  });
});

describe("resolveEntityHint", () => {
  it("returns nothing for an absent hint", () => {
    expect(resolveEntityHint(undefined, entities)).toEqual({
      entityId: null,
      hint: null,
    });
  });

  it("confidently matches exact names, case/whitespace-insensitively", () => {
    expect(
      resolveEntityHint({ text: "dr.  PATEL", basis: "manual" }, entities),
    ).toEqual({ entityId: "prov-patel", hint: null });
    // Secondary names (full name) match too.
    expect(
      resolveEntityHint(
        { text: "Dr. Anika Patel, DDS", basis: "source_metadata" },
        entities,
      ),
    ).toEqual({ entityId: "prov-patel", hint: null });
  });

  it("keeps a near-miss as a hint with its basis preserved — never a guessed FK", () => {
    const hint = { text: "Dr. Patell", basis: "inferred_text" as const };
    expect(resolveEntityHint(hint, entities)).toEqual({
      entityId: null,
      hint,
    });
    // Substring/prefix is a near-miss too.
    expect(
      resolveEntityHint({ text: "Patel", basis: "inferred_text" }, entities),
    ).toMatchObject({ entityId: null });
  });

  it("treats an ambiguous match (two entities, one name) as not confident", () => {
    const twins: NamedEntity[] = [
      { id: "a", names: ["Dr. Lee"] },
      { id: "b", names: ["Dr. Lee"] },
    ];
    const hint = { text: "Dr. Lee", basis: "inferred_text" as const };
    expect(resolveEntityHint(hint, twins)).toEqual({ entityId: null, hint });
  });

  it("ignores null names", () => {
    expect(
      resolveEntityHint({ text: "Dr. Kim", basis: "manual" }, entities),
    ).toEqual({ entityId: "prov-kim", hint: null });
  });
});
