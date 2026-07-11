/**
 * Staff role vocabulary — the single source of truth for the `staff_role`
 * Postgres enum in `@wellregarded/db` and the permission matrix in Epic #4.
 *
 * Domain vocabulary lives here in core so the database schema and the
 * permission layer consume the same constant: one list, no drift. Adding a
 * role means appending here and generating a migration in `packages/db`
 * (Postgres enums are append-friendly; removal is a fix-forward migration).
 */
export const STAFF_ROLES = [
  "owner",
  "office_manager",
  "front_desk",
  "marketing",
  "provider",
  "multi_location_admin",
  "external_partner",
] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

/**
 * Clerk organization role → our staff role, used by the webhook sync
 * (issue #60, Epic #4) when it INSERTS a `staff_members` row.
 *
 * Deliberately coarse: Clerk only distinguishes admin/member, and real role
 * assignment is a Settings feature later. The sync applies this map **on
 * insert only, never on update** — a role changed in our DB (the source of
 * truth for roles) must never be overwritten by a webhook replay.
 *
 * Unknown Clerk roles (e.g. custom roles added in the Clerk dashboard) fall
 * back to `DEFAULT_SYNCED_ROLE`; the sync logs a warning when that happens.
 */
export const ROLE_MAP: Readonly<Record<string, StaffRole>> = {
  "org:admin": "owner",
  "org:member": "front_desk",
};

/** Conservative default for Clerk roles missing from `ROLE_MAP`. */
export const DEFAULT_SYNCED_ROLE: StaffRole = "front_desk";
