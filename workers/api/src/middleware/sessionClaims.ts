/**
 * Clerk session-token claim extraction (issue #68 requirement 2).
 *
 * Clerk ships two session-token formats and both are in the wild:
 * - v2: the active organization lives under the `o` claim —
 *   `o.id` (org id) and `o.rol` (role name WITHOUT the `org:` prefix).
 * - v1: flat `org_id` / `org_role` claims (`org_role` carries the
 *   `org:` prefix, e.g. `org:admin`).
 *
 * This is the single place that knows about either shape, so format drift
 * is contained here (and covered by sessionClaims.test.ts). The role is
 * normalized to the prefixed form (`org:admin`) to match webhook payloads
 * and `ROLE_MAP` in @wellregarded/core — note the staff-auth middleware
 * itself never trusts the token's role; roles come from our DB.
 */

/** What the middleware needs from a verified session token. */
export interface OrgClaims {
  /** Active organization id (`org_…`), or null when no org is active. */
  orgId: string | null;
  /** Normalized `org:`-prefixed role, or null when absent. */
  orgRole: string | null;
}

/**
 * Structural view of the claims we read — deliberately loose so a payload
 * from either token version (or a future one) type-checks; every field is
 * re-validated at runtime.
 */
export interface SessionClaimsInput {
  o?: { id?: unknown; rol?: unknown } | null;
  org_id?: unknown;
  org_role?: unknown;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeRole(role: string): string {
  return role.startsWith("org:") ? role : `org:${role}`;
}

export function extractOrgClaims(payload: SessionClaimsInput): OrgClaims {
  // v2 first: when both shapes are somehow present, the versioned claim
  // wins (v2 tokens declare `org_id`/`org_role` as never-set).
  const v2Id = asNonEmptyString(payload.o?.id);
  if (v2Id) {
    const rol = asNonEmptyString(payload.o?.rol);
    return { orgId: v2Id, orgRole: rol ? normalizeRole(rol) : null };
  }

  const v1Id = asNonEmptyString(payload.org_id);
  if (v1Id) {
    const role = asNonEmptyString(payload.org_role);
    return { orgId: v1Id, orgRole: role ? normalizeRole(role) : null };
  }

  return { orgId: null, orgRole: null };
}
