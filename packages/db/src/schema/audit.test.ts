import { AUDIT_ACTOR_TYPES } from "@wellregarded/core";
import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { auditActorTypeEnum, auditLog } from "./audit.js";

describe("audit_log schema (unit)", () => {
  it("derives the actor-type enum from the core constants", () => {
    // One source of truth: the `Actor` union in @wellregarded/core and the
    // Epic #4 auth surfaces consume the same constants, so the helper and
    // the schema cannot drift.
    expect(auditActorTypeEnum.enumName).toBe("audit_actor_type");
    expect(auditActorTypeEnum.enumValues).toEqual([...AUDIT_ACTOR_TYPES]);
  });

  it("exposes the audit_log table under its SQL name", () => {
    expect(getTableName(auditLog)).toBe("audit_log");
  });
});
