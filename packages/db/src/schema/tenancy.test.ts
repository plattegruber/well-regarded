import { STAFF_ROLES } from "@wellregarded/core";
import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  locations,
  practices,
  providers,
  staffMembers,
  staffRoleEnum,
} from "./tenancy.js";

describe("tenancy schema (unit)", () => {
  it("derives the staff_role enum from the core STAFF_ROLES constant", () => {
    // One source of truth: the pgEnum must track @wellregarded/core exactly
    // (the Epic #4 permission matrix consumes the same constant).
    expect(staffRoleEnum.enumName).toBe("staff_role");
    expect(staffRoleEnum.enumValues).toEqual([...STAFF_ROLES]);
  });

  it("exposes the four tenancy tables under their SQL names", () => {
    expect(getTableName(practices)).toBe("practices");
    expect(getTableName(locations)).toBe("locations");
    expect(getTableName(providers)).toBe("providers");
    expect(getTableName(staffMembers)).toBe("staff_members");
  });
});
