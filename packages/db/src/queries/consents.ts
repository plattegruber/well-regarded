/**
 * Consent queries — the publication gate (issue #38, Epic #3).
 *
 * `isPublishable` below is THE single entry point for publication
 * eligibility. Any publication path (Proof API in Epic #14, proof library in
 * Epic #13, review responses in Epic #10, GBP placement) that does not call
 * it is a bug. There is no `is_publishable` boolean anywhere — eligibility
 * is computed at read time from append-only `consents` rows. See
 * packages/db/CONSENT.md.
 */

import {
  type ConsentAttribution,
  type ConsentChannel,
  type ConsentDecision,
  type ConsentSource,
  evaluateConsent,
} from "@wellregarded/core";
import { eq, sql } from "drizzle-orm";

import type { Db } from "../client.js";
import { consents } from "../schema/consents.js";

/** A `consents` row (assignable to core's `ConsentRow`). */
export type Consent = typeof consents.$inferSelect;

/**
 * Can `signalId` be published on `channel` right now?
 *
 * **The single publication gate.** Every publication path MUST call this —
 * a path that checks anything else (or caches the answer in a flag) is a
 * bug. Fetches the signal's consent rows and delegates the decision to the
 * pure `evaluateConsent` in `@wellregarded/core`; the returned decision
 * carries the winning consent row so callers can apply attribution and
 * minor-edit rules, and a `reason` so UIs can explain a refusal.
 */
export async function isPublishable(
  db: Db,
  signalId: string,
  channel: ConsentChannel,
): Promise<ConsentDecision<Consent>> {
  const rows = await db
    .select()
    .from(consents)
    .where(eq(consents.signalId, signalId));
  return evaluateConsent(rows, channel, new Date());
}

export interface GrantConsentInput {
  practiceId: string;
  signalId: string;
  /** NULL for practice-attested imports where we have no patient record. */
  patientId?: string | null;
  channels: ConsentChannel[];
  attribution: ConsentAttribution;
  allowMinorEdits?: boolean;
  grantedAt: Date;
  source: ConsentSource;
  expiresAt?: Date | null;
}

/**
 * Record a consent grant (or narrowing, or re-grant after revocation) as a
 * new versioned row. `consent_version` is computed as
 * `max(consent_version) + 1` for the signal inside the same transaction as
 * the insert — callers never hand-roll version math. Concurrent grants for
 * the same signal surface as a unique violation on
 * `(signal_id, consent_version)` (Postgres error 23505): retryable, never
 * silently mis-versioned.
 */
export async function grantConsent(
  db: Db,
  input: GrantConsentInput,
): Promise<Consent> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        maxVersion: sql<number>`coalesce(max(${consents.consentVersion}), 0)`,
      })
      .from(consents)
      .where(eq(consents.signalId, input.signalId));

    const [row] = await tx
      .insert(consents)
      .values({
        practiceId: input.practiceId,
        signalId: input.signalId,
        patientId: input.patientId ?? null,
        channels: input.channels,
        attribution: input.attribution,
        allowMinorEdits: input.allowMinorEdits ?? false,
        grantedAt: input.grantedAt,
        source: input.source,
        consentVersion: (current?.maxVersion ?? 0) + 1,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    if (!row) throw new Error("consent insert returned no row");
    return row;
  });
}

/**
 * Revoke the currently-active consent for a signal by stamping `revoked_at`
 * on its highest-version active row. This is the ONE permitted UPDATE on
 * `consents` (see the table doc comment); a re-grant after revocation is a
 * new row via `grantConsent`. Returns the revoked row, or `undefined` when
 * the signal has no active consent to revoke.
 */
export async function revokeConsent(
  db: Db,
  signalId: string,
  revokedAt: Date,
): Promise<Consent | undefined> {
  const [row] = await db
    .update(consents)
    .set({ revokedAt })
    .where(
      eq(
        consents.id,
        sql`(
          SELECT c.id FROM ${consents} c
          WHERE c.signal_id = ${signalId} AND c.revoked_at IS NULL
          ORDER BY c.consent_version DESC
          LIMIT 1
        )`,
      ),
    )
    .returning();
  return row;
}
