/**
 * Consent vocabulary — enums, row shapes, and zod schemas (issues #38 and
 * #84, Epics #3 and #12).
 *
 * Ethical invariant #2: nothing publishes without an explicit consent join.
 * There is no `is_publishable` boolean anywhere in the system — publication
 * eligibility is always computed, at read time, from append-only `consents`
 * rows by the pure functions in this directory (`checkConsent` in
 * `./check.js` is the single decision point; see `packages/db/CONSENT.md`).
 *
 * The enum constants are the single source of truth for the `consents`
 * table's Postgres enums in `@wellregarded/db`: one list, no drift. The zod
 * schemas mirror the same lists so the pure write helpers (`grantConsent`,
 * `revokeConsent`) validate their inputs against the identical vocabulary.
 */

import { z } from "zod";

/** Where republication is allowed. */
export const CONSENT_CHANNELS = [
  "website",
  "gbp",
  "email",
  "in_office",
] as const;

export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

export const consentChannelSchema = z.enum(CONSENT_CHANNELS);

/** How the patient may be identified when their words are republished. */
export const CONSENT_ATTRIBUTIONS = [
  "full_name",
  "first_name",
  "initials",
  "anonymous",
] as const;

export type ConsentAttribution = (typeof CONSENT_ATTRIBUTIONS)[number];

export const consentAttributionSchema = z.enum(CONSENT_ATTRIBUTIONS);

/**
 * How the consent was obtained. Precedence, not just provenance:
 * `patient_link` rows always govern over the other sources — a patient's
 * own decision can never be overridden by staff (see `governingConsent` in
 * `./check.js`).
 */
export const CONSENT_SOURCES = [
  "patient_link",
  "practice_attested",
  "imported_unknown",
] as const;

export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export const consentSourceSchema = z.enum(CONSENT_SOURCES);

/**
 * The fields of a `consents` row that the pure decision logic reads.
 * Structural on purpose: the full Drizzle row type in `@wellregarded/db` is
 * assignable to it, and the functions are generic so callers get their own
 * row type back in the decision.
 */
export interface ConsentRow {
  channels: readonly ConsentChannel[];
  attribution: ConsentAttribution;
  allowMinorEdits: boolean;
  grantedAt: Date;
  source: ConsentSource;
  /** Monotonic per signal, starting at 1. Ordering within a source. */
  consentVersion: number;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

/**
 * A `ConsentRow` that also carries its identity columns — what the pure
 * `revokeConsent` needs to build a revocation row (it copies the scope of
 * the grant being revoked). The Drizzle `Consent` row in `@wellregarded/db`
 * is assignable to it.
 */
export interface IdentifiedConsentRow extends ConsentRow {
  practiceId: string;
  signalId: string;
  patientId: string | null;
}

/**
 * Values for a new `consents` row, as produced by the pure `grantConsent`
 * and `revokeConsent` builders. Mirrors the table's insertable columns
 * (camelCase, matching the Drizzle insert shape in `@wellregarded/db`).
 * Never an UPDATE: grants, narrowings, re-grants, and revocations are all
 * new rows — `consents` is append-only.
 */
export interface ConsentVersionInsert {
  practiceId: string;
  signalId: string;
  patientId: string | null;
  channels: ConsentChannel[];
  attribution: ConsentAttribution;
  allowMinorEdits: boolean;
  grantedAt: Date;
  source: ConsentSource;
  consentVersion: number;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

/**
 * The next `consent_version` for a signal: `max(existing) + 1`, starting at
 * 1. The single place version math lives — callers never hand-roll it. The
 * effectful writers in `@wellregarded/db` compute the max inside the same
 * transaction as the insert, and the unique index on
 * `(signal_id, consent_version)` turns races into retryable conflicts.
 */
export function nextConsentVersion(
  existing: readonly { consentVersion: number }[],
): number {
  let max = 0;
  for (const row of existing) {
    if (row.consentVersion > max) max = row.consentVersion;
  }
  return max + 1;
}

/** Display labels for consent channels — sentence case, per the voice rules. */
export const CONSENT_CHANNEL_LABELS: Record<ConsentChannel, string> = {
  website: "Website",
  gbp: "Google profile",
  email: "Email",
  in_office: "In office",
};
