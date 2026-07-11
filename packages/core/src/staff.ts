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
