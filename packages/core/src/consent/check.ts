/**
 * The pure publication-eligibility check (issues #38 and #84, Epics #3 and
 * #12).
 *
 * `checkConsent` is THE decision point for "may this be published?". No DB,
 * no network — callers fetch a signal's consent rows, this function
 * decides. `isPublishable` in `@wellregarded/db` is the thin effectful
 * wrapper every publication path calls; see `packages/db/CONSENT.md` and
 * the "Publication checks" section of CONTRIBUTING.md.
 */

import {
  CONSENT_CHANNEL_LABELS,
  type ConsentChannel,
  type ConsentRow,
} from "./model.js";

/**
 * The row that governs a signal's current consent state (issue #84).
 *
 * Precedence: **`patient_link` always beats the staff-side sources.** Rows
 * are partitioned by source first — if any `patient_link` row exists, the
 * latest `patient_link` row governs and `practice_attested` /
 * `imported_unknown` rows are ignored entirely; a patient's decision can
 * never be overridden by staff, in either direction (a staff attestation
 * cannot re-enable what a patient revoked, and a staff "revocation" cannot
 * silence a patient's grant). Within a partition the highest
 * `consent_version` wins — version ordering is the truth, never timestamps.
 */
export function governingConsent<T extends ConsentRow>(
  rows: readonly T[],
): T | undefined {
  const patient = rows.filter((row) => row.source === "patient_link");
  return latestVersion(patient.length > 0 ? patient : rows);
}

/** The highest-`consent_version` row of a partition. */
function latestVersion<T extends ConsentRow>(
  rows: readonly T[],
): T | undefined {
  let latest: T | undefined;
  for (const row of rows) {
    if (latest === undefined || row.consentVersion > latest.consentVersion) {
      latest = row;
    }
  }
  return latest;
}

/**
 * Why a signal is (or is not) publishable on a channel. The reason shape
 * matters: Epic #13's proof library shows *why* something isn't publishable,
 * not just that it isn't.
 */
export type ConsentRefusalReason =
  | "no_consent"
  | "revoked"
  | "expired"
  | "channel_not_granted";

export type ConsentDecisionReason = ConsentRefusalReason | "ok";

/**
 * The discriminated result of `checkConsent`: allowed carries the governing
 * consent row (callers need it for attribution and minor-edit rules);
 * refusals carry a `reason` — and the governing row when one exists — so
 * UIs can explain *why* (revoked vs expired vs channel-not-granted vs
 * no-consent), not just deny.
 */
export type ConsentCheck<T extends ConsentRow = ConsentRow> =
  | { allowed: true; consent: T }
  | { allowed: false; reason: ConsentRefusalReason; consent?: T };

/**
 * Pure point-in-time publication check for one signal (issue #84) — no
 * I/O, unit-testable in isolation.
 *
 * Rules:
 * - The governing row is resolved by `governingConsent`: latest applicable
 *   version wins, and `patient_link` always beats `practice_attested`.
 * - No rows → `no_consent`.
 * - Governing row revoked → `revoked` (a re-grant after revocation is a
 *   newer version and governs instead).
 * - `expires_at` at or before `at` (default: now) → `expired` (expiry is
 *   exclusive: a grant is dead the instant it expires).
 * - `channel` outside the governing row's `channels` scope →
 *   `channel_not_granted`.
 *
 * Refusal reasons are reported in that order: a revoked grant that also
 * lacks the channel reports `revoked` — revocation rows carry the revoked
 * grant's scope only as history, and the patient's "no" is the headline.
 *
 * Earlier versions are never consulted: granting, narrowing, and revoking
 * are all new rows, so the governing row is the complete current state.
 */
export function checkConsent<T extends ConsentRow>(
  rows: readonly T[],
  channel: ConsentChannel,
  at: Date = new Date(),
): ConsentCheck<T> {
  const governing = governingConsent(rows);

  if (governing === undefined) {
    return { allowed: false, reason: "no_consent" };
  }
  if (governing.revokedAt !== null) {
    return { allowed: false, reason: "revoked", consent: governing };
  }
  if (
    governing.expiresAt !== null &&
    governing.expiresAt.getTime() <= at.getTime()
  ) {
    return { allowed: false, reason: "expired", consent: governing };
  }
  if (!governing.channels.includes(channel)) {
    return {
      allowed: false,
      reason: "channel_not_granted",
      consent: governing,
    };
  }
  return { allowed: true, consent: governing };
}

export interface ConsentDecision<T extends ConsentRow = ConsentRow> {
  publishable: boolean;
  reason: ConsentDecisionReason;
  /**
   * The governing consent row, when one exists — callers need it for
   * attribution and edit rules, and failure reasons other than `no_consent`
   * include it so UIs can explain the decision.
   */
  consent?: T;
}

/**
 * `checkConsent` in the `ConsentDecision` shape (issue #38's original
 * surface, kept for the `isPublishable` gate in `@wellregarded/db` and its
 * consumers). Same rules, same reasons — it delegates to `checkConsent`.
 */
export function evaluateConsent<T extends ConsentRow>(
  rows: readonly T[],
  channel: ConsentChannel,
  now: Date,
): ConsentDecision<T> {
  const check = checkConsent(rows, channel, now);
  if (check.allowed) {
    return { publishable: true, reason: "ok", consent: check.consent };
  }
  return check.consent === undefined
    ? { publishable: false, reason: check.reason }
    : { publishable: false, reason: check.reason, consent: check.consent };
}

/** The channel-independent current consent state of one signal. */
export type ConsentStateStatus = "none" | "granted" | "revoked" | "expired";

/**
 * What the consent panel (issue #90) and the inbox's rights column (issue
 * #88) render. `summary` is one calm line — sentence case, no exclamation
 * points — that states publishability strictly in terms of recorded
 * consent, never a default-open state.
 */
export interface ConsentStateDescription<T extends ConsentRow = ConsentRow> {
  /** True when the current grant is active on at least one channel. */
  publishable: boolean;
  status: ConsentStateStatus;
  summary: string;
  /** The governing consent row, when one exists. */
  consent?: T;
}

/**
 * Channel-independent counterpart of `checkConsent` (issue #90): the ONE
 * interpretation of "what does this signal's recorded consent say", shared
 * by the signal detail's consent panel, the inbox's rights column, and the
 * proof surfaces (Epics #12/#13). Publication paths still gate per channel
 * through `isPublishable` in `@wellregarded/db` — this is display logic,
 * not the publication gate.
 *
 * Rules mirror `checkConsent`: only the governing row (source precedence,
 * then highest version) is consulted; no rows is the honest default ("No
 * consent recorded — not publishable"); revoked and expired state their
 * reason.
 */
export function describeConsentState<T extends ConsentRow>(
  rows: readonly T[],
  now: Date,
): ConsentStateDescription<T> {
  const governing = governingConsent(rows);

  if (governing === undefined) {
    return {
      publishable: false,
      status: "none",
      summary: "No consent recorded — not publishable",
    };
  }
  if (governing.revokedAt !== null) {
    return {
      publishable: false,
      status: "revoked",
      summary: "Consent revoked — not publishable",
      consent: governing,
    };
  }
  if (
    governing.expiresAt !== null &&
    governing.expiresAt.getTime() <= now.getTime()
  ) {
    return {
      publishable: false,
      status: "expired",
      summary: "Consent expired — not publishable",
      consent: governing,
    };
  }
  if (governing.channels.length === 0) {
    return {
      publishable: false,
      status: "granted",
      summary: "No channels granted — not publishable",
      consent: governing,
    };
  }
  const channels = governing.channels
    .map((channel) => CONSENT_CHANNEL_LABELS[channel])
    .join(" + ");
  return {
    publishable: true,
    status: "granted",
    summary: `${channels} permission granted`,
    consent: governing,
  };
}
