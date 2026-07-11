/**
 * Patient contact vocabulary — the single source of truth for the
 * `contact_kind` and `contact_consent_hint` Postgres enums on
 * `pii.contact_points` in `@wellregarded/db` (issue #47, Epic #3).
 *
 * Domain vocabulary lives here in core so the database schema and every
 * consumer (Epic #19's suppression checks, Epic #20's PMS sync) share the
 * same constants: one list, no drift. Adding a value means appending here
 * and generating a migration in `packages/db`.
 */

/** How we can reach a patient — one row per channel per value. */
export const CONTACT_KINDS = ["sms", "email"] as const;

export type ContactKind = (typeof CONTACT_KINDS)[number];

/**
 * What the source system told us about contactability. A *hint* for
 * Epic #19's suppression checks — NOT publication consent, which is only
 * ever the `consents` table (see packages/db/CONSENT.md).
 */
export const CONTACT_CONSENT_HINTS = [
  "unknown",
  "implied",
  "explicit",
] as const;

export type ContactConsentHint = (typeof CONTACT_CONSENT_HINTS)[number];
