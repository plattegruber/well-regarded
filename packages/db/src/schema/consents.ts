/**
 * `consents` — append-only versioned consent (issue #38, Epic #3).
 *
 * Ethical invariant #2: nothing publishes without an explicit consent join.
 * There is no `is_publishable` boolean anywhere in the system — and there
 * must never be one. No convenience booleans, no cached flags, no
 * `published` column on `signals`: if a later issue wants one, it is wrong.
 * Publication eligibility is always computed, at read time, by
 * `isPublishable` in `../queries/consents.js` — the single entry point every
 * publication path MUST call (see packages/db/CONSENT.md).
 *
 * Consent is scoped to a specific piece of content (`signal_id`) — a patient
 * consents to *this review* being reused, never blanket.
 *
 * Append-only: consent versions are never edited. Granting, narrowing, and
 * revoking are all new rows (`consent_version` is monotonic per signal,
 * starting at 1), so we can always answer "what was consented to at the time
 * we published X". The one permitted UPDATE is stamping `revoked_at` on the
 * currently-active row (`revokeConsent` in `../queries/consents.js`; a
 * re-grant after revocation is a new row with a higher version). The
 * audit-log issue in this epic records every such change.
 */

import {
  CONSENT_ATTRIBUTIONS,
  CONSENT_CHANNELS,
  CONSENT_SOURCES,
} from "@wellregarded/core";
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { patients } from "./pii.js";
import { signals } from "./signals.js";
import { practices } from "./tenancy.js";

// Enum values sourced from @wellregarded/core (one source of truth;
// `evaluateConsent` in core consumes the same constants).
export const consentChannelEnum = pgEnum("consent_channel", CONSENT_CHANNELS);
export const consentAttributionEnum = pgEnum(
  "consent_attribution",
  CONSENT_ATTRIBUTIONS,
);
export const consentSourceEnum = pgEnum("consent_source", CONSENT_SOURCES);

export const consents = pgTable(
  "consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id),
    /**
     * FK to `pii.patients` (deferred from #38, added by #47). SET NULL on
     * patient delete — deleting a patient must never destroy consent
     * history. NULL for practice-attested imports where we have no patient
     * record.
     */
    patientId: uuid("patient_id").references(() => patients.id, {
      onDelete: "set null",
    }),
    /** Where republication is allowed. */
    channels: consentChannelEnum("channels").array().notNull(),
    attribution: consentAttributionEnum("attribution").notNull(),
    allowMinorEdits: boolean("allow_minor_edits").notNull().default(false),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
    source: consentSourceEnum("source").notNull(),
    /**
     * Monotonic per `signal_id`, starting at 1 — assigned by `grantConsent`
     * (never hand-roll version math; the unique index below turns races into
     * retryable conflicts).
     */
    consentVersion: integer("consent_version").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("consents_signal_id_consent_version_idx").on(
      table.signalId,
      table.consentVersion,
    ),
    index("consents_signal_id_granted_at_idx").on(
      table.signalId,
      table.grantedAt.desc(),
    ),
  ],
);
