import { describe, expect, it } from "vitest";

import { extractOrgClaims } from "./sessionClaims";

describe("extractOrgClaims (issue #68 requirement 2)", () => {
  it("reads v2 claims (o.id / o.rol) and normalizes the role prefix", () => {
    expect(extractOrgClaims({ o: { id: "org_abc", rol: "admin" } })).toEqual({
      orgId: "org_abc",
      orgRole: "org:admin",
    });
  });

  it("keeps an already-prefixed v2 role as-is", () => {
    expect(
      extractOrgClaims({ o: { id: "org_abc", rol: "org:member" } }),
    ).toEqual({ orgId: "org_abc", orgRole: "org:member" });
  });

  it("reads v1 claims (org_id / org_role)", () => {
    expect(
      extractOrgClaims({ org_id: "org_abc", org_role: "org:admin" }),
    ).toEqual({ orgId: "org_abc", orgRole: "org:admin" });
  });

  it("returns null orgId when no org is active (either format)", () => {
    expect(extractOrgClaims({})).toEqual({ orgId: null, orgRole: null });
    expect(extractOrgClaims({ o: null })).toEqual({
      orgId: null,
      orgRole: null,
    });
    expect(extractOrgClaims({ o: {} })).toEqual({ orgId: null, orgRole: null });
  });

  it("prefers v2 over v1 when both are present", () => {
    expect(
      extractOrgClaims({
        o: { id: "org_v2", rol: "member" },
        org_id: "org_v1",
        org_role: "org:admin",
      }),
    ).toEqual({ orgId: "org_v2", orgRole: "org:member" });
  });

  it("tolerates format drift: non-string values never leak through", () => {
    expect(
      extractOrgClaims({ o: { id: 42, rol: ["admin"] }, org_id: 42 }),
    ).toEqual({ orgId: null, orgRole: null });
    expect(extractOrgClaims({ org_id: "org_abc", org_role: 7 })).toEqual({
      orgId: "org_abc",
      orgRole: null,
    });
  });

  it("treats empty strings as absent", () => {
    expect(extractOrgClaims({ o: { id: "", rol: "" } })).toEqual({
      orgId: null,
      orgRole: null,
    });
  });
});
