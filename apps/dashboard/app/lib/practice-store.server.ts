// Practice store — a stubbed, in-memory stand-in for the real `practices`
// table behind a narrow interface.
//
// TODO(#59): the real store needs the authenticated actor (Clerk, Epic #4)
// to know whose practice to read, and Drizzle + Hyperdrive to persist.
// When auth lands: implement `PracticeStore` against `@wellregarded/db`
// (update + `audit("practice.updated", actor)` in one transaction), derive
// the id from the actor, and delete the memory store. The conventions the
// reference page demonstrates (#141) are the deliverable here — not this
// persistence.
//
// Module-scope state is per-isolate on Workers: edits survive navigation
// within a session (enough to demonstrate the full form loop) and reset on
// cold start. Do not copy this pattern for real data.
import type { PracticeProfileInput, StaffActor } from "@wellregarded/core";

export interface PracticeProfile extends PracticeProfileInput {
  id: string;
}

export interface PracticeStore {
  get(id: string): Promise<PracticeProfile | null>;
  update(id: string, patch: PracticeProfileInput): Promise<PracticeProfile>;
}

/** The designer's demo practice — same fixture the shell footer shows. */
export const DEMO_PRACTICE_ID = "00000000-0000-4000-8000-000000000001";

/**
 * TODO(#59): replaced by the actor Epic #4's middleware derives from the
 * Clerk session. Until then every request acts as the demo practice's
 * owner so the permission check in the action recipe runs for real.
 */
export const DEMO_ACTOR: StaffActor = {
  type: "staff",
  staffId: "00000000-0000-4000-8000-000000000002",
  practiceId: DEMO_PRACTICE_ID,
  role: "owner",
  locationId: null,
};

const DEMO_ROW: PracticeProfile = {
  id: DEMO_PRACTICE_ID,
  name: "Cedar Ridge Dental",
  phone: "(555) 201-4400",
  websiteUrl: "https://cedarridgedental.example",
  timezone: "America/Chicago",
};

const rows = new Map<string, PracticeProfile>();
resetPracticeStore();

export const practiceStore: PracticeStore = {
  async get(id) {
    return rows.get(id) ?? null;
  },
  async update(id, patch) {
    const current = rows.get(id);
    if (!current) {
      throw new Error(`Unknown practice ${id}`);
    }
    const next = { ...current, ...patch };
    rows.set(id, next);
    return next;
  },
};

/** Test-only: restore the seeded demo row between tests. */
export function resetPracticeStore(): void {
  rows.clear();
  rows.set(DEMO_PRACTICE_ID, { ...DEMO_ROW });
}
