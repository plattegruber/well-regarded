/**
 * Consent vocabulary and the pure publication-eligibility check
 * (issue #38, Epic #3).
 *
 * Ethical invariant #2: nothing publishes without an explicit consent join.
 * There is no `is_publishable` boolean anywhere in the system — publication
 * eligibility is always computed, at read time, from append-only `consents`
 * rows. `evaluateConsent` here is the pure decision logic (no I/O);
 * `isPublishable` in `@wellregarded/db` fetches a signal's consent rows and
 * delegates to it. Every publication path MUST go through `isPublishable` —
 * see `packages/db/CONSENT.md`.
 *
 * The enum constants are the single source of truth for the `consents`
 * table's Postgres enums in `@wellregarded/db`: one list, no drift.
 */

/** Where republication is allowed. */
export const CONSENT_CHANNELS = [
  "website",
  "gbp",
  "email",
  "in_office",
] as const;

export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

/** How the patient may be identified when their words are republished. */
export const CONSENT_ATTRIBUTIONS = [
  "full_name",
  "first_name",
  "initials",
  "anonymous",
] as const;

export type ConsentAttribution = (typeof CONSENT_ATTRIBUTIONS)[number];

/** How the consent was obtained. */
export const CONSENT_SOURCES = [
  "patient_link",
  "practice_attested",
  "imported_unknown",
] as const;

export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/**
 * The fields of a `consents` row that `evaluateConsent` reads. Structural on
 * purpose: the full Drizzle row type in `@wellregarded/db` is assignable to
 * it, and `evaluateConsent` is generic so callers get their own row type
 * back in the decision.
 */
export interface ConsentRow {
  channels: readonly ConsentChannel[];
  attribution: ConsentAttribution;
  allowMinorEdits: boolean;
  grantedAt: Date;
  source: ConsentSource;
  /** Monotonic per signal, starting at 1. The highest version is current. */
  consentVersion: number;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

/**
 * Why a signal is (or is not) publishable on a channel. The reason shape
 * matters: Epic #13's proof library shows *why* something isn't publishable,
 * not just that it isn't.
 */
export type ConsentDecisionReason =
  | "no_consent"
  | "channel_not_granted"
  | "revoked"
  | "expired"
  | "ok";

export interface ConsentDecision<T extends ConsentRow = ConsentRow> {
  publishable: boolean;
  reason: ConsentDecisionReason;
  /**
   * The winning (highest-version) consent row, when one exists — callers
   * need it for attribution and edit rules, and failure reasons other than
   * `no_consent` include it so UIs can explain the decision.
   */
  consent?: T;
}

/**
 * Pure publication-eligibility check — no I/O, unit-testable in isolation.
 *
 * Rules (issue #38): take the row with the highest `consent_version` for the
 * signal; publishable iff that row exists, `channel ∈ channels`,
 * `revoked_at IS NULL`, and (`expires_at IS NULL` or `expires_at > now`).
 * Failure reasons are reported in that same order (a revoked grant that also
 * lacks the channel reports `channel_not_granted` first).
 *
 * Earlier versions are never consulted: granting, narrowing, and revoking
 * are all new rows, so the highest version is the complete current state.
 */
export function evaluateConsent<T extends ConsentRow>(
  rows: readonly T[],
  channel: ConsentChannel,
  now: Date,
): ConsentDecision<T> {
  let winning: T | undefined;
  for (const row of rows) {
    if (winning === undefined || row.consentVersion > winning.consentVersion) {
      winning = row;
    }
  }

  if (winning === undefined) {
    return { publishable: false, reason: "no_consent" };
  }
  if (!winning.channels.includes(channel)) {
    return {
      publishable: false,
      reason: "channel_not_granted",
      consent: winning,
    };
  }
  if (winning.revokedAt !== null) {
    return { publishable: false, reason: "revoked", consent: winning };
  }
  if (
    winning.expiresAt !== null &&
    winning.expiresAt.getTime() <= now.getTime()
  ) {
    return { publishable: false, reason: "expired", consent: winning };
  }
  return { publishable: true, reason: "ok", consent: winning };
}
