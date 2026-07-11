import type { StaffRole } from "../staff.js";

/**
 * The authenticated staff member asking to act. This is the same shape the
 * Hono API middleware sets on request context and `audit()` consumes —
 * defined here, once, so every layer speaks the same actor.
 *
 * `locationId: null` means the member is unscoped (practice-wide); a string
 * pins them to a single location for `scoped` matrix cells.
 */
export type StaffActor = {
  type: "staff";
  staffId: string;
  practiceId: string;
  role: StaffRole;
  locationId: string | null;
};

/**
 * The thing being acted on. `locationId` absent or `null` means the resource
 * is practice-wide (not tied to one location).
 */
export type Resource = {
  practiceId: string;
  locationId?: string | null;
};
