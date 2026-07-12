/**
 * The demo practice's proofs and placements (issue #96, Epic #13) — one of
 * each state so the proof library, the Proof API, and E2E have real rows:
 *
 * - an APPROVED excerpt-level proof (fp01, the mockup's "Jordan M." quote,
 *   active `patient_link` website consent) with a live website placement;
 * - an APPROVED whole-signal proof (cs02, practice-attested) not yet
 *   placed anywhere;
 * - a SUGGESTED whole-signal proof (g01) — exactly what the route stage's
 *   proof sink writes: no display text, no approver, no consent yet;
 * - an ARCHIVED proof (fp06, whose consent the patient revoked) with a
 *   placement deactivated for `consent_revoked` — the issue-91 story.
 *
 * Cross-checked against ./signals.ts: `signal` keys must exist there, and
 * `excerptIndex` must index into that fixture's `excerpts`.
 *
 * SEED CONTRACT: changes here bump `SEED_VERSION` (see ../constants.ts).
 */

import {
  PLACEMENT_DEACTIVATION_CONSENT_REVOKED,
  type PlacementChannel,
  type ProofStatus,
} from "@wellregarded/core";

import type { StaffKey } from "./demoPractice.js";

export interface PlacementFixture {
  /** Stable key — `seedId(\`placement:${key}\`)` is the row's primary key. */
  key: string;
  channel: PlacementChannel;
  /** Free-text hint: the page/topic the proof is placed on. */
  target?: string;
  active: boolean;
  activatedDaysAgo: number;
  deactivatedDaysAgo?: number;
  deactivationReason?: string;
}

export interface ProofFixture {
  /** Stable key — `seedId(\`proof:${key}\`)` is the row's primary key. */
  key: string;
  /** Key of the parent fixture in ./signals.ts. */
  signal: string;
  /** Index into the signal fixture's `excerpts`; omitted = whole-signal. */
  excerptIndex?: number;
  status: ProofStatus;
  /**
   * What gets published — initialized from the original at approval
   * (#105); omitted on suggestions (the route sink never sets it).
   */
  displayText?: string;
  approvedBy?: StaffKey;
  approvedDaysAgo?: number;
  createdDaysAgo: number;
  placements?: PlacementFixture[];
}

export const PROOF_FIXTURES: ProofFixture[] = [
  {
    key: "fp01-anxiety",
    signal: "fp01",
    excerptIndex: 0,
    status: "approved",
    displayText:
      "I was terrified going into this, but Dr. Patel explained every step and it was much easier than I expected.",
    approvedBy: "office_manager",
    approvedDaysAgo: 8,
    createdDaysAgo: 9,
    placements: [
      {
        key: "fp01-anxiety-website",
        channel: "website",
        target: "implant anxiety page",
        active: true,
        activatedDaysAgo: 7,
      },
    ],
  },
  {
    key: "cs02-referrals",
    signal: "cs02",
    status: "approved",
    displayText:
      "I have recommended Dr. Patel to three coworkers already. The implant consult alone was worth the visit.",
    approvedBy: "owner_aldana",
    approvedDaysAgo: 60,
    createdDaysAgo: 62,
  },
  {
    key: "g01-suggested",
    signal: "g01",
    status: "suggested",
    createdDaysAgo: 11,
  },
  {
    key: "fp06-crown",
    signal: "fp06",
    status: "archived",
    displayText:
      "Dr. Aldana made my crown appointment painless. You can quote me on that.",
    approvedBy: "office_manager",
    approvedDaysAgo: 45,
    createdDaysAgo: 48,
    placements: [
      {
        key: "fp06-crown-website",
        channel: "website",
        target: "homepage testimonials",
        active: false,
        activatedDaysAgo: 44,
        // The patient revoked consent 12 days before the anchor (see
        // fp06 in ./signals.ts); the issue-91 cascade took the placement
        // down the same day with the machine-written reason.
        deactivatedDaysAgo: 12,
        deactivationReason: PLACEMENT_DEACTIVATION_CONSENT_REVOKED,
      },
    ],
  },
];
