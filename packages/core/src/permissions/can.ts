import type { Action } from "./actions.js";
import { PERMISSION_MATRIX } from "./matrix.js";
import type { Resource, StaffActor } from "./types.js";

/**
 * The one permission check — pure, no I/O — consulted by dashboard
 * loaders/actions, Hono API middleware, and (rendered-disabled) UI alike.
 * Never re-derive this logic ad hoc.
 *
 * Evaluation order:
 * 1. Tenancy wall: a different `practiceId` is always `false`, regardless
 *    of role — even `owner` cannot cross practices.
 * 2. Matrix cell `deny` → `false`; `allow` → `true`.
 * 3. Cell `scoped` → `true` when any of:
 *    - the actor is unscoped (`actor.locationId === null`, practice-wide
 *      member), or
 *    - the resource is practice-wide (`resource.locationId` absent or
 *      `null`), or
 *    - the actor's and resource's locations match;
 *    otherwise `false` (least privilege: a location-scoped actor never
 *    reaches another location's resources).
 */
export function can(
  actor: StaffActor,
  action: Action,
  resource: Resource,
): boolean {
  if (actor.practiceId !== resource.practiceId) {
    return false;
  }

  const cell = PERMISSION_MATRIX[actor.role][action];
  switch (cell) {
    case "deny":
      return false;
    case "allow":
      return true;
    case "scoped":
      return (
        actor.locationId === null ||
        resource.locationId === undefined ||
        resource.locationId === null ||
        actor.locationId === resource.locationId
      );
  }
}
