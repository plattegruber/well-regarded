/**
 * Audit actor vocabulary — the single source of truth for the
 * `audit_actor_type` Postgres enum in `@wellregarded/db` (issue #46,
 * Epic #3) and the `Actor` union every auth surface produces.
 *
 * The three actor types deliberately mirror the three auth surfaces Epic #4
 * builds: staff JWT middleware (`staff`), system jobs (`system`), and
 * patient link tokens (`patient_token`). Epic #4's middleware constructs
 * `Actor` values; `audit()` in `@wellregarded/db` consumes them — one type,
 * no parallel unions.
 */
export const AUDIT_ACTOR_TYPES = ["staff", "system", "patient_token"] as const;

export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * Who performed an audited action.
 *
 * - `staff` — `id` is `staff_members.id`.
 * - `system` — `id` is a worker/job name, e.g. `pipeline:classify`.
 * - `patient_token` — `jti` is the patient link token's JWT ID.
 */
export type Actor =
  | { type: "staff"; id: string }
  | { type: "system"; id: string }
  | { type: "patient_token"; jti: string };
