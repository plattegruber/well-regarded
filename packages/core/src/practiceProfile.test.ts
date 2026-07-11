import { describe, expect, it } from "vitest";
import { z } from "zod";

import { isIanaTimeZone, practiceProfileSchema } from "./practiceProfile";

describe("practiceProfileSchema", () => {
  const valid = {
    name: "Cedar Ridge Dental",
    phone: "(555) 201-4400",
    websiteUrl: "https://cedarridgedental.com",
    timezone: "America/Chicago",
  };

  it("accepts a complete profile", () => {
    const result = practiceProfileSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("trims the name and requires it", () => {
    const trimmed = practiceProfileSchema.safeParse({
      ...valid,
      name: "  Cedar Ridge Dental  ",
    });
    expect(trimmed.success).toBe(true);
    if (trimmed.success) {
      expect(trimmed.data.name).toBe("Cedar Ridge Dental");
    }

    const empty = practiceProfileSchema.safeParse({ ...valid, name: "   " });
    expect(empty.success).toBe(false);
  });

  it("normalizes empty optional fields to null", () => {
    const result = practiceProfileSchema.safeParse({
      ...valid,
      phone: "",
      websiteUrl: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phone).toBeNull();
      expect(result.data.websiteUrl).toBeNull();
    }
  });

  it("rejects a malformed website URL", () => {
    const result = practiceProfileSchema.safeParse({
      ...valid,
      websiteUrl: "cedarridge",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const { fieldErrors } = z.flattenError(result.error);
      expect(fieldErrors.websiteUrl).toEqual([
        "Enter a full URL, like https://example.com.",
      ]);
    }
  });

  it("rejects an unknown time zone", () => {
    const result = practiceProfileSchema.safeParse({
      ...valid,
      timezone: "Mars/Olympus_Mons",
    });
    expect(result.success).toBe(false);
  });
});

describe("isIanaTimeZone", () => {
  it("accepts real zones and rejects invented ones", () => {
    expect(isIanaTimeZone("America/Chicago")).toBe(true);
    expect(isIanaTimeZone("UTC")).toBe(true);
    expect(isIanaTimeZone("Not/A_Zone")).toBe(false);
    expect(isIanaTimeZone("")).toBe(false);
  });
});
