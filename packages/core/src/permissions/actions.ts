/**
 * Permission action vocabulary — every capability the permission matrix
 * governs. `can()` answers "may this actor perform this action on this
 * resource?" for exactly these actions; callers never invent ad-hoc ones.
 *
 * Adding an action means appending here; the `Record<Action, …>` types in
 * `matrix.ts` then fail to compile until every role's cell is written out,
 * and the exhaustive tests plus generated docs pick it up automatically.
 */
export const ACTIONS = [
  "view_patient_identity",
  "view_private_feedback",
  "assign_recovery",
  "resolve_duplicates",
  "reclassify_signal",
  "draft_response",
  "approve_response",
  "publish_public",
  "manage_consent",
  "edit_profile_data",
  "manage_settings",
  "view_reports",
  "manage_api_keys",
] as const;

export type Action = (typeof ACTIONS)[number];
