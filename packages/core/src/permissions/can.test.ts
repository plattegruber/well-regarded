import { describe, expect, it } from "vitest";

import { STAFF_ROLES, type StaffRole } from "../staff";
import { ACTIONS, type Action } from "./actions";
import { can } from "./can";
import { PERMISSION_MATRIX, type PermissionCell } from "./matrix";
import type { Resource, StaffActor } from "./types";

/**
 * Independent snapshot of the expected matrix, written action-major to
 * mirror the table in issue #62 (and `docs/permissions.md`). Kept separate
 * from `PERMISSION_MATRIX` on purpose: a cell changed in the source must be
 * consciously changed here too. The `Record` types make this snapshot fail
 * to compile if a role or action is added without filling in every cell.
 */
const EXPECTED: Record<Action, Record<StaffRole, PermissionCell>> = {
  view_patient_identity: {
    owner: "allow",
    office_manager: "allow",
    front_desk: "scoped",
    marketing: "deny",
    provider: "deny",
    multi_location_admin: "allow",
    external_partner: "deny",
  },
  view_private_feedback: {
    owner: "allow",
    office_manager: "allow",
    front_desk: "scoped",
    marketing: "allow",
    provider: "scoped",
    multi_location_admin: "allow",
    external_partner: "deny",
  },
  assign_recovery: {
    owner: "allow",
    office_manager: "allow",
    front_desk: "scoped",
    marketing: "deny",
    provider: "deny",
    multi_location_admin: "allow",
    external_partner: "deny",
  },
  resolve_duplicates: {
    owner: "allow",
    office_manager: "allow",
    front_desk: "scoped",
    marketing: "deny",
    provider: "deny",
    multi_location_admin: "allow",
    external_partner: "deny",
  },
  draft_response: {
    owner: "allow",
    office_manager: "allow",
    front_desk: "scoped",
    marketing: "allow",
    provider: "deny",
    multi_location_admin: "allow",
    external_partner: "allow",
  },
  approve_response: {
    owner: "allow",
    office_manager: "allow",
    front_desk: "deny",
    marketing: "deny",
    provider: "deny",
    multi_location_admin: "allow",
    external_partner: "deny",
  },
  publish_public: {
    owner: "allow",
    office_manager: "allow",
    front_desk: "deny",
    marketing: "allow",
    provider: "deny",
    multi_location_admin: "allow",
    external_partner: "deny",
  },
  manage_consent: {
    owner: "allow",
    office_manager: "allow",
    front_desk: "scoped",
    marketing: "deny",
    provider: "deny",
    multi_location_admin: "allow",
    external_partner: "deny",
  },
  edit_profile_data: {
    owner: "allow",
    office_manager: "allow",
    front_desk: "deny",
    marketing: "allow",
    provider: "deny",
    multi_location_admin: "allow",
    external_partner: "allow",
  },
  manage_settings: {
    owner: "allow",
    office_manager: "allow",
    front_desk: "deny",
    marketing: "deny",
    provider: "deny",
    multi_location_admin: "allow",
    external_partner: "deny",
  },
  view_reports: {
    owner: "allow",
    office_manager: "allow",
    front_desk: "deny",
    marketing: "allow",
    provider: "scoped",
    multi_location_admin: "allow",
    external_partner: "allow",
  },
  manage_api_keys: {
    owner: "allow",
    office_manager: "deny",
    front_desk: "deny",
    marketing: "deny",
    provider: "deny",
    multi_location_admin: "deny",
    external_partner: "deny",
  },
};

const PRACTICE = "practice_1";
const OTHER_PRACTICE = "practice_2";
const LOCATION_A = "location_a";
const LOCATION_B = "location_b";

function actor(role: StaffRole, locationId: string | null = null): StaffActor {
  return {
    type: "staff",
    staffId: `staff_${role}`,
    practiceId: PRACTICE,
    role,
    locationId,
  };
}

function resource(locationId?: string | null): Resource {
  return locationId === undefined
    ? { practiceId: PRACTICE }
    : { practiceId: PRACTICE, locationId };
}

describe("PERMISSION_MATRIX", () => {
  it("covers every role and every action exactly once (7 × 11 grid)", () => {
    expect(Object.keys(PERMISSION_MATRIX).sort()).toEqual(
      [...STAFF_ROLES].sort(),
    );
    for (const role of STAFF_ROLES) {
      expect(Object.keys(PERMISSION_MATRIX[role]).sort()).toEqual(
        [...ACTIONS].sort(),
      );
    }
  });

  it("matches the expected snapshot for all 77 cells", () => {
    for (const action of ACTIONS) {
      for (const role of STAFF_ROLES) {
        expect(
          PERMISSION_MATRIX[role][action],
          `matrix cell (${role}, ${action})`,
        ).toBe(EXPECTED[action][role]);
      }
    }
  });
});

describe("can()", () => {
  it("resolves all 77 (role, action) pairs per the matrix for a same-practice, practice-wide check", () => {
    for (const action of ACTIONS) {
      for (const role of STAFF_ROLES) {
        // An unscoped actor on a practice-wide resource: `scoped` behaves
        // like `allow`, so the outcome is fully determined by the cell.
        const expected = EXPECTED[action][role] !== "deny";
        expect(
          can(actor(role), action, resource()),
          `can(${role}, ${action})`,
        ).toBe(expected);
      }
    }
  });

  describe("tenancy wall", () => {
    it("denies across practices regardless of role, even for `allow` cells", () => {
      const crossPractice: Resource = { practiceId: OTHER_PRACTICE };
      for (const role of STAFF_ROLES) {
        for (const action of ACTIONS) {
          expect(
            can(actor(role), action, crossPractice),
            `cross-practice can(${role}, ${action})`,
          ).toBe(false);
        }
      }
    });

    it("denies across practices even when locations would match", () => {
      expect(
        can(actor("front_desk", LOCATION_A), "view_patient_identity", {
          practiceId: OTHER_PRACTICE,
          locationId: LOCATION_A,
        }),
      ).toBe(false);
    });
  });

  describe("location scoping (`scoped` cells)", () => {
    // front_desk / view_patient_identity is a `scoped` cell.
    const action = "view_patient_identity";

    it("allows a location-scoped actor on a resource at their own location", () => {
      expect(
        can(actor("front_desk", LOCATION_A), action, resource(LOCATION_A)),
      ).toBe(true);
    });

    it("denies a location-scoped actor on a resource at another location", () => {
      expect(
        can(actor("front_desk", LOCATION_A), action, resource(LOCATION_B)),
      ).toBe(false);
    });

    it("allows an unscoped actor (locationId null) on any location's resource", () => {
      expect(can(actor("front_desk", null), action, resource(LOCATION_B))).toBe(
        true,
      );
    });

    it("allows a location-scoped actor on a practice-wide resource (locationId absent)", () => {
      expect(can(actor("front_desk", LOCATION_A), action, resource())).toBe(
        true,
      );
    });

    it("allows a location-scoped actor on a practice-wide resource (locationId null)", () => {
      expect(can(actor("front_desk", LOCATION_A), action, resource(null))).toBe(
        true,
      );
    });

    it("applies to provider's scoped cells too (location scope, not provider-identity scope)", () => {
      expect(
        can(
          actor("provider", LOCATION_A),
          "view_private_feedback",
          resource(LOCATION_B),
        ),
      ).toBe(false);
      expect(
        can(
          actor("provider", LOCATION_A),
          "view_reports",
          resource(LOCATION_A),
        ),
      ).toBe(true);
    });
  });

  describe("location scoping does not affect `allow`/`deny` cells", () => {
    it("`allow` cells ignore location mismatch", () => {
      expect(
        can(
          actor("owner", LOCATION_A),
          "manage_settings",
          resource(LOCATION_B),
        ),
      ).toBe(true);
    });

    it("`deny` cells stay denied even with matching locations", () => {
      expect(
        can(
          actor("marketing", LOCATION_A),
          "view_patient_identity",
          resource(LOCATION_A),
        ),
      ).toBe(false);
    });
  });
});
