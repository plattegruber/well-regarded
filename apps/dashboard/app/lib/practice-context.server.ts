// THE auth seam for data-backed loaders and actions.
//
// TODO(#59): NO AUTH IS WIRED YET. Until Epic #4 lands Clerk, every request
// acts as the seeded demo practice's owner — a full-permission dev actor.
// When auth arrives, ONLY THIS FUNCTION changes: it derives the practice and
// actor from the Clerk session (and throws 401/403 `data()` responses)
// instead of looking up the demo fixtures. Callers already treat its result
// as "the authenticated context", so nothing else moves.
//
// This is deliberately DB-backed rather than a constant: the returned ids
// are real seeded rows, so audit entries (`patient.viewed`,
// `suspected_duplicate.*`) reference a real staff member and queries scope
// to a real practice — the same shape production will have.
import { type Actor, can, type StaffActor } from "@wellregarded/core";
import {
  type Db,
  getPracticeByClerkOrgId,
  getStaffMemberByRole,
  type SignalViewerPermissions,
} from "@wellregarded/db";
import { data } from "react-router";

/** The demo practice's stable natural key (packages/db seed contract). */
const DEMO_CLERK_ORG_ID = "org_demo_cedar_ridge";

export interface PracticeContext {
  practiceId: string;
  /** The practice's display name (the drafting prompt's one non-review input). */
  practiceName: string;
  /** The permission-matrix actor — `can(actor, action, resource)`. */
  actor: StaffActor;
  /** The audit-log actor shape for `audit()` / audited query helpers. */
  auditActor: Actor;
  /** The two data-layer gates the signals queries enforce. */
  viewer: SignalViewerPermissions;
}

/**
 * Resolve the acting practice + staff actor for this request.
 * TODO(#59): replace the demo lookup with the Clerk session.
 */
export async function requirePracticeContext(db: Db): Promise<PracticeContext> {
  const practice = await getPracticeByClerkOrgId(db, DEMO_CLERK_ORG_ID);
  const owner = practice
    ? await getStaffMemberByRole(db, practice.id, "owner")
    : undefined;
  if (!practice || !owner) {
    // Local dev without seed data: say so plainly instead of a blank page.
    throw data("Demo practice not found — run `pnpm seed` first.", {
      status: 503,
    });
  }

  const actor: StaffActor = {
    type: "staff",
    staffId: owner.id,
    practiceId: practice.id,
    role: "owner",
    locationId: null,
  };
  return {
    practiceId: practice.id,
    practiceName: practice.name,
    actor,
    auditActor: { type: "staff", id: actor.staffId },
    viewer: {
      viewPrivateFeedback: can(actor, "view_private_feedback", {
        practiceId: practice.id,
      }),
      viewPatientIdentity: can(actor, "view_patient_identity", {
        practiceId: practice.id,
      }),
    },
  };
}
