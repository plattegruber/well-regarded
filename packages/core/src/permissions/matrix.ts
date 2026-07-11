import type { StaffRole } from "../staff";
import type { Action } from "./actions";

/**
 * One cell of the permission matrix:
 * - `allow`  — permitted anywhere in the actor's practice.
 * - `deny`   — never permitted.
 * - `scoped` — permitted, but only within the actor's location scope
 *              (see `can()` for the exact semantics).
 */
export type PermissionCell = "allow" | "deny" | "scoped";

/**
 * The permission matrix as data — the single source of truth consulted by
 * `can()`, the exhaustive tests, and the generated `docs/permissions.md`.
 *
 * Every cell is written out explicitly (no defaults, no spreads): the
 * `Record<StaffRole, Record<Action, PermissionCell>>` type makes adding a
 * role or action a compile error until every new cell is decided, and the
 * exhaustive tests iterate the full 7 × 11 grid.
 *
 * Notes:
 * - `provider` cells marked `scoped` (view_private_feedback, view_reports)
 *   use *location* scope, not provider-identity scope. "Only feedback about
 *   me" is a future refinement — do not build it here.
 * - No superuser/support role and no per-practice overrides for now; the
 *   matrix-as-data design makes both easy to add later.
 * - Cell values are a product starting point and may be tuned in review;
 *   the shape, `can()`, tests, and doc generation are the durable parts.
 */
export const PERMISSION_MATRIX: Record<
  StaffRole,
  Record<Action, PermissionCell>
> = {
  owner: {
    view_patient_identity: "allow",
    view_private_feedback: "allow",
    assign_recovery: "allow",
    draft_response: "allow",
    approve_response: "allow",
    publish_public: "allow",
    manage_consent: "allow",
    edit_profile_data: "allow",
    manage_settings: "allow",
    view_reports: "allow",
    manage_api_keys: "allow",
  },
  office_manager: {
    view_patient_identity: "allow",
    view_private_feedback: "allow",
    assign_recovery: "allow",
    draft_response: "allow",
    approve_response: "allow",
    publish_public: "allow",
    manage_consent: "allow",
    edit_profile_data: "allow",
    manage_settings: "allow",
    view_reports: "allow",
    manage_api_keys: "deny",
  },
  front_desk: {
    view_patient_identity: "scoped",
    view_private_feedback: "scoped",
    assign_recovery: "scoped",
    draft_response: "scoped",
    approve_response: "deny",
    publish_public: "deny",
    manage_consent: "scoped",
    edit_profile_data: "deny",
    manage_settings: "deny",
    view_reports: "deny",
    manage_api_keys: "deny",
  },
  marketing: {
    view_patient_identity: "deny",
    view_private_feedback: "allow",
    assign_recovery: "deny",
    draft_response: "allow",
    approve_response: "deny",
    publish_public: "allow",
    manage_consent: "deny",
    edit_profile_data: "allow",
    manage_settings: "deny",
    view_reports: "allow",
    manage_api_keys: "deny",
  },
  provider: {
    view_patient_identity: "deny",
    view_private_feedback: "scoped",
    assign_recovery: "deny",
    draft_response: "deny",
    approve_response: "deny",
    publish_public: "deny",
    manage_consent: "deny",
    edit_profile_data: "deny",
    manage_settings: "deny",
    view_reports: "scoped",
    manage_api_keys: "deny",
  },
  multi_location_admin: {
    view_patient_identity: "allow",
    view_private_feedback: "allow",
    assign_recovery: "allow",
    draft_response: "allow",
    approve_response: "allow",
    publish_public: "allow",
    manage_consent: "allow",
    edit_profile_data: "allow",
    manage_settings: "allow",
    view_reports: "allow",
    manage_api_keys: "deny",
  },
  external_partner: {
    view_patient_identity: "deny",
    view_private_feedback: "deny",
    assign_recovery: "deny",
    draft_response: "allow",
    approve_response: "deny",
    publish_public: "deny",
    manage_consent: "deny",
    edit_profile_data: "allow",
    manage_settings: "deny",
    view_reports: "allow",
    manage_api_keys: "deny",
  },
};
