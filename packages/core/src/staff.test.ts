import { describe, expect, it } from "vitest";

import { DEFAULT_SYNCED_ROLE, ROLE_MAP, STAFF_ROLES } from "./staff";

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

describe("ROLE_MAP (Clerk org role → staff role, issue #60)", () => {
  it("maps the two built-in Clerk roles exactly as specified", () => {
    expect(ROLE_MAP).toEqual({
      "org:admin": "owner",
      "org:member": "front_desk",
    });
  });

  it("maps only onto known staff roles", () => {
    for (const role of Object.values(ROLE_MAP)) {
      expect(STAFF_ROLES).toContain(role);
    }
  });

  it("falls back to the least-privileged everyday role", () => {
    expect(DEFAULT_SYNCED_ROLE).toBe("front_desk");
  });
});
