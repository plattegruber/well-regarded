import {
  CONSENT_ATTRIBUTIONS,
  CONSENT_CHANNELS,
  CONSENT_SOURCES,
} from "@wellregarded/core";
import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  consentAttributionEnum,
  consentChannelEnum,
  consentSourceEnum,
  consents,
} from "./consents.js";

describe("consents schema (unit)", () => {
  it("derives all three enums from the core constants", () => {
    // One source of truth: evaluateConsent in @wellregarded/core consumes
    // the same constants, so the pure logic and the schema cannot drift.
    expect(consentChannelEnum.enumName).toBe("consent_channel");
    expect(consentChannelEnum.enumValues).toEqual([...CONSENT_CHANNELS]);
    expect(consentAttributionEnum.enumName).toBe("consent_attribution");
    expect(consentAttributionEnum.enumValues).toEqual([
      ...CONSENT_ATTRIBUTIONS,
    ]);
    expect(consentSourceEnum.enumName).toBe("consent_source");
    expect(consentSourceEnum.enumValues).toEqual([...CONSENT_SOURCES]);
  });

  it("exposes the consents table under its SQL name", () => {
    expect(getTableName(consents)).toBe("consents");
  });
});
