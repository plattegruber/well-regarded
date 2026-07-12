/**
 * Proof vocabulary (issue #96, Epic #13).
 *
 * A **proof** is a governed decision to use a signal (or one of its
 * excerpts) beyond its source; a **placement** records where it is used.
 * The enum constants here are the single source of truth for the `proofs`
 * and `placements` Postgres enums in `@wellregarded/db` — one list, no
 * drift (the same pattern as `CONSENT_CHANNELS` in ./consent.ts).
 *
 * Eligibility to actually SERVE a proof is never a status: it is computed
 * at read time by `publishableProofs` in `@wellregarded/db`, whose consent
 * join encodes `checkConsent` (see packages/db/CONSENT.md). `approved`
 * means a human decided the proof may be used — consent still gates it.
 */

import type { ConsentChannel } from "./consent/index.js";

/**
 * Proof lifecycle: the route stage (or a staff member) suggests, a human
 * approves, and archiving retires — an archived proof never serves and
 * frees the signal/excerpt for a fresh suggestion.
 */
export const PROOF_STATUSES = ["suggested", "approved", "archived"] as const;

export type ProofStatus = (typeof PROOF_STATUSES)[number];

/** Where a proof can be placed. */
export const PLACEMENT_CHANNELS = [
  "website",
  "gbp_post",
  "email",
  "in_office",
] as const;

export type PlacementChannel = (typeof PLACEMENT_CHANNELS)[number];

/**
 * The consent channel a placement channel is governed by: placements are
 * product surfaces, consent channels are what patients grant, and the two
 * vocabularies differ only at Google (`gbp_post` placements are covered by
 * the `gbp` consent grant). Any code that checks whether a placement may
 * serve maps through here before calling the consent gate.
 */
export const PLACEMENT_CONSENT_CHANNEL: Record<
  PlacementChannel,
  ConsentChannel
> = {
  website: "website",
  gbp_post: "gbp",
  email: "email",
  in_office: "in_office",
};

export function consentChannelForPlacement(
  channel: PlacementChannel,
): ConsentChannel {
  return PLACEMENT_CONSENT_CHANNEL[channel];
}

/**
 * The `placements.deactivation_reason` value written when a consent
 * revocation cascades to active placements (issue #91). The column is
 * free text — staff record their own reasons — but this one value is
 * machine-written and machine-read, so it is a constant, not a string
 * literal scattered across issues #91/#84.
 */
export const PLACEMENT_DEACTIVATION_CONSENT_REVOKED = "consent_revoked";
