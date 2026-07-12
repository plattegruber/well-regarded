/**
 * Tenancy lookups for the app edges (Epic #4/#11). Kept in `packages/db`
 * so apps never write inline queries: the dashboard's auth seam
 * (`requirePracticeContext`, TODO(#59)) resolves its practice and staff
 * rows through these, and the Clerk middleware will reuse
 * `getPracticeByClerkOrgId` when real auth lands.
 */

import { and, eq } from "drizzle-orm";

import type { Tx } from "../audit.js";
import type { Db } from "../client.js";
import { practices, staffMembers } from "../schema/tenancy.js";

/** A `practices` row. */
export type Practice = typeof practices.$inferSelect;

/** A `staff_members` row. */
export type StaffMember = typeof staffMembers.$inferSelect;

/** Find a practice by its Clerk organization id (the auth-surface key). */
export async function getPracticeByClerkOrgId(
  db: Db | Tx,
  clerkOrgId: string,
): Promise<Practice | undefined> {
  const [row] = await db
    .select()
    .from(practices)
    .where(eq(practices.clerkOrgId, clerkOrgId))
    .limit(1);
  return row;
}

/** The practice's staff with a given role; first row or `undefined`. */
export async function getStaffMemberByRole(
  db: Db | Tx,
  practiceId: string,
  role: StaffMember["role"],
): Promise<StaffMember | undefined> {
  const [row] = await db
    .select()
    .from(staffMembers)
    .where(
      and(eq(staffMembers.practiceId, practiceId), eq(staffMembers.role, role)),
    )
    .limit(1);
  return row;
}
