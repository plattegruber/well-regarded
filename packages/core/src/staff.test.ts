import { describe, expect, it } from "vitest";

import { STAFF_ROLES } from "./staff";

describe("STAFF_ROLES", () => {
  it("contains the full role vocabulary, without duplicates", () => {
    expect(STAFF_ROLES).toEqual([
      "owner",
      "office_manager",
      "front_desk",
      "marketing",
      "provider",
      "multi_location_admin",
      "external_partner",
    ]);
    expect(new Set(STAFF_ROLES).size).toBe(STAFF_ROLES.length);
  });

  it("uses snake_case values (they become Postgres enum labels)", () => {
    for (const role of STAFF_ROLES) {
      expect(role).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
