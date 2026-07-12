import { describe, expect, it } from "vitest";

import {
  type NormalizedSignal,
  normalizedSignalSchema,
  patientHintSchema,
  ratingSchema,
} from "./normalizedSignal.js";

/** A fully-populated valid signal to mutate from. */
const valid: NormalizedSignal = {
  visibility: "public",
  occurredAt: "2026-03-02T14:30:00Z",
  originalText: "Wonderful hygienist, gentle and thorough.",
  rating: { value: 4, scale: 5 },
  authorDisplayName: "Jamie R.",
  authorExternalId: "acct-123",
  sourceKind: "google",
  sourceId: "accounts/1/locations/2/reviews/3",
  sourceUrl: "https://maps.google.com/review/3",
  patientHint: { name: "Jamie Rivera", email: "jamie@example.com" },
  providerHint: { text: "Dr. Patel", basis: "inferred_text" },
  locationHint: { text: "Main Street office", basis: "source_metadata" },
  consentHint: "imported_unknown",
  sourceMetadata: {
    sourceUpdatedAt: "2026-03-05T08:00:00Z",
    existingReply: {
      comment: "Thanks for the kind words!",
      updateTime: "2026-03-04T10:00:00Z",
      state: "APPROVED",
    },
  },
};

describe("normalizedSignalSchema", () => {
  it("accepts a fully-populated signal", () => {
    expect(normalizedSignalSchema.parse(valid)).toEqual(valid);
  });

  it("accepts the minimal shape (nullables null, optionals absent)", () => {
    const minimal: NormalizedSignal = {
      visibility: "private",
      occurredAt: "2026-01-15T09:00:00+02:00",
      originalText: null,
      rating: null,
      authorDisplayName: null,
      authorExternalId: null,
      sourceKind: "manual",
      sourceId: null,
      sourceUrl: null,
    };
    expect(normalizedSignalSchema.parse(minimal)).toEqual(minimal);
  });

  it("rejects unknown keys (strict — typos must fail loudly)", () => {
    expect(
      normalizedSignalSchema.safeParse({ ...valid, sentiment: "positive" })
        .success,
    ).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { visibility: _visibility, ...withoutVisibility } = valid;
    expect(normalizedSignalSchema.safeParse(withoutVisibility).success).toBe(
      false,
    );
    const { originalText: _text, ...withoutText } = valid;
    // Nullable is not optional: the key must be present, even as null.
    expect(normalizedSignalSchema.safeParse(withoutText).success).toBe(false);
  });

  it("rejects bad enum values", () => {
    expect(
      normalizedSignalSchema.safeParse({ ...valid, visibility: "internal" })
        .success,
    ).toBe(false);
    expect(
      normalizedSignalSchema.safeParse({ ...valid, sourceKind: "yelp" })
        .success,
    ).toBe(false);
    expect(
      normalizedSignalSchema.safeParse({ ...valid, consentHint: "verbal" })
        .success,
    ).toBe(false);
    // patient_link is a real ConsentSource but never a valid adapter hint.
    expect(
      normalizedSignalSchema.safeParse({
        ...valid,
        consentHint: "patient_link",
      }).success,
    ).toBe(false);
  });

  it("rejects non-datetime occurredAt", () => {
    for (const bad of ["yesterday", "2026-03-02", 1741000000]) {
      expect(
        normalizedSignalSchema.safeParse({ ...valid, occurredAt: bad }).success,
      ).toBe(false);
    }
  });

  it("rejects a non-URL sourceUrl but allows null", () => {
    expect(
      normalizedSignalSchema.safeParse({ ...valid, sourceUrl: "not a url" })
        .success,
    ).toBe(false);
    expect(
      normalizedSignalSchema.safeParse({ ...valid, sourceUrl: null }).success,
    ).toBe(true);
  });

  it("rejects hints with a bad or missing basis", () => {
    expect(
      normalizedSignalSchema.safeParse({
        ...valid,
        providerHint: { text: "Dr. Patel", basis: "gut_feeling" },
      }).success,
    ).toBe(false);
    expect(
      normalizedSignalSchema.safeParse({
        ...valid,
        locationHint: { text: "Main Street office" },
      }).success,
    ).toBe(false);
  });

  it("sourceMetadata is strict: unknown keys and bad values fail loudly", () => {
    expect(
      normalizedSignalSchema.safeParse({
        ...valid,
        sourceMetadata: { sourceUpdatedAt: "2026-03-05T08:00:00Z" },
      }).success,
    ).toBe(true);
    // Empty metadata is valid (both fields optional) — adapters simply
    // omit the field when they have nothing to say.
    expect(
      normalizedSignalSchema.safeParse({ ...valid, sourceMetadata: {} })
        .success,
    ).toBe(true);
    expect(
      normalizedSignalSchema.safeParse({
        ...valid,
        sourceMetadata: { sourceUpdatedat: "2026-03-05T08:00:00Z" },
      }).success,
    ).toBe(false);
    expect(
      normalizedSignalSchema.safeParse({
        ...valid,
        sourceMetadata: { sourceUpdatedAt: "yesterday" },
      }).success,
    ).toBe(false);
    expect(
      normalizedSignalSchema.safeParse({
        ...valid,
        sourceMetadata: {
          existingReply: { comment: "Thanks!", state: "SHADOWBANNED" },
        },
      }).success,
    ).toBe(false);
    expect(
      normalizedSignalSchema.safeParse({
        ...valid,
        sourceMetadata: {
          existingReply: { updateTime: "2026-03-04T10:00:00Z" },
        },
      }).success,
    ).toBe(false); // a reply without its comment is not a reply
  });

  it("accepts every value of the standard basis vocabulary", () => {
    for (const basis of [
      "source_metadata",
      "manual",
      "inferred_text",
      "inferred_related",
    ]) {
      expect(
        normalizedSignalSchema.safeParse({
          ...valid,
          providerHint: { text: "Dr. Patel", basis },
        }).success,
      ).toBe(true);
    }
  });
});

describe("ratingSchema", () => {
  it("keeps the source's own scale", () => {
    expect(ratingSchema.parse({ value: 9, scale: 10 })).toEqual({
      value: 9,
      scale: 10,
    });
  });

  it("rejects a bad scale", () => {
    expect(ratingSchema.safeParse({ value: 3, scale: 0 }).success).toBe(false);
    expect(ratingSchema.safeParse({ value: 3, scale: -5 }).success).toBe(false);
    expect(ratingSchema.safeParse({ value: 3, scale: 4.5 }).success).toBe(
      false,
    );
  });

  it("rejects a value outside the scale", () => {
    expect(ratingSchema.safeParse({ value: 6, scale: 5 }).success).toBe(false);
    expect(ratingSchema.safeParse({ value: -1, scale: 5 }).success).toBe(false);
  });
});

describe("patientHintSchema", () => {
  it("requires at least one contact field", () => {
    expect(patientHintSchema.safeParse({}).success).toBe(false);
    expect(patientHintSchema.safeParse({ name: "Jamie" }).success).toBe(true);
    expect(patientHintSchema.safeParse({ phone: "+1 555 0100" }).success).toBe(
      true,
    );
  });

  it("rejects a malformed email", () => {
    expect(patientHintSchema.safeParse({ email: "not-an-email" }).success).toBe(
      false,
    );
  });

  it("rejects unknown keys", () => {
    expect(
      patientHintSchema.safeParse({ name: "Jamie", ssn: "000-00-0000" })
        .success,
    ).toBe(false);
  });
});
