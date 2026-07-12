import { describe, expect, it } from "vitest";

import { manualSignalFormSchema } from "./manualEntry.js";

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const BASE = {
  text: "Dr. Patel was wonderful with my daughter.",
  occurredOn: "2026-01-15",
  sourceDescription: "phone call",
  consent: { choice: "unknown" as const },
};

describe("manualSignalFormSchema", () => {
  it("accepts the minimal text-only payload", () => {
    const parsed = manualSignalFormSchema.parse(BASE);
    expect(parsed.text).toBe(BASE.text);
    expect(parsed.consent).toEqual({ choice: "unknown" });
  });

  it("accepts the full payload (patient + attested consent + hints)", () => {
    const parsed = manualSignalFormSchema.parse({
      ...BASE,
      locationId: "0f9619ff-8b86-4d01-b42d-00cf4fc964ff",
      providerId: "1f9619ff-8b86-4d01-b42d-00cf4fc964ff",
      patient: { name: "Rosa Alvarez", email: "rosa@example.com" },
      consent: {
        choice: "practice_attested",
        channels: ["website", "gbp"],
        note: "Said yes over the phone, 3/2, spoke with Dana.",
      },
    });
    expect(parsed.patient?.name).toBe("Rosa Alvarez");
    expect(parsed.consent.choice).toBe("practice_attested");
  });

  it("requires text, date, and source description", () => {
    for (const missing of ["text", "occurredOn", "sourceDescription"]) {
      const { [missing as keyof typeof BASE]: _drop, ...rest } = BASE;
      expect(manualSignalFormSchema.safeParse(rest).success).toBe(false);
    }
    expect(
      manualSignalFormSchema.safeParse({ ...BASE, text: "   " }).success,
    ).toBe(false);
  });

  it("accepts today but rejects future dates", () => {
    expect(
      manualSignalFormSchema.safeParse({
        ...BASE,
        occurredOn: isoDate(new Date()),
      }).success,
    ).toBe(true);
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    expect(
      manualSignalFormSchema.safeParse({
        ...BASE,
        occurredOn: isoDate(nextWeek),
      }).success,
    ).toBe(false);
  });

  it("rejects malformed dates", () => {
    for (const bad of ["01/15/2026", "2026-1-5", "2026-13-40", "yesterday"]) {
      expect(
        manualSignalFormSchema.safeParse({ ...BASE, occurredOn: bad }).success,
      ).toBe(false);
    }
  });

  it("attested consent requires a non-empty note and at least one channel", () => {
    expect(
      manualSignalFormSchema.safeParse({
        ...BASE,
        consent: {
          choice: "practice_attested",
          channels: ["website"],
          note: "   ",
        },
      }).success,
    ).toBe(false);
    expect(
      manualSignalFormSchema.safeParse({
        ...BASE,
        consent: { choice: "practice_attested", channels: [], note: "note" },
      }).success,
    ).toBe(false);
    expect(
      manualSignalFormSchema.safeParse({
        ...BASE,
        consent: {
          choice: "practice_attested",
          channels: ["bad_channel"],
          note: "note",
        },
      }).success,
    ).toBe(false);
  });

  it("unknown consent carries no channels or note", () => {
    expect(
      manualSignalFormSchema.safeParse({
        ...BASE,
        consent: { choice: "unknown", note: "stray" },
      }).success,
    ).toBe(false);
  });

  it("an empty patient object is rejected; one field suffices", () => {
    expect(
      manualSignalFormSchema.safeParse({ ...BASE, patient: {} }).success,
    ).toBe(false);
    expect(
      manualSignalFormSchema.safeParse({
        ...BASE,
        patient: { phone: "+1 555 014 0000" },
      }).success,
    ).toBe(true);
    expect(
      manualSignalFormSchema.safeParse({
        ...BASE,
        patient: { email: "not-an-email" },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields (visibility is deliberately not accepted)", () => {
    expect(
      manualSignalFormSchema.safeParse({ ...BASE, visibility: "public" })
        .success,
    ).toBe(false);
  });
});
