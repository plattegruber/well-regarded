import { CONTACT_CONSENT_HINTS, CONTACT_KINDS } from "@wellregarded/core";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  contactConsentHintEnum,
  contactKindEnum,
  contactPoints,
  patients,
} from "./pii.js";

describe("pii schema (unit)", () => {
  it("derives both enums from the core constants", () => {
    expect(contactKindEnum.enumName).toBe("contact_kind");
    expect(contactKindEnum.enumValues).toEqual([...CONTACT_KINDS]);
    expect(contactConsentHintEnum.enumName).toBe("contact_consent_hint");
    expect(contactConsentHintEnum.enumValues).toEqual([
      ...CONTACT_CONSENT_HINTS,
    ]);
  });

  it("places both tables in the isolated pii schema (the HIPAA-shaped boundary)", () => {
    expect(getTableName(patients)).toBe("patients");
    expect(getTableConfig(patients).schema).toBe("pii");
    expect(getTableName(contactPoints)).toBe("contact_points");
    expect(getTableConfig(contactPoints).schema).toBe("pii");
  });

  it("stores contact values only as ciphertext + hash — no plaintext column", () => {
    const columnNames = getTableConfig(contactPoints).columns.map(
      (column) => column.name,
    );
    expect(columnNames).toContain("value_encrypted");
    expect(columnNames).toContain("value_hash");
    expect(columnNames).not.toContain("value");
  });
});
