/**
 * Pure consent-grant builder (issue #84, Epic #12).
 *
 * No DB, no network: given a validated input and the signal's existing
 * consent versions, produce the values for a new `consents` row. The
 * effectful writer (`grantConsent` in `@wellregarded/db`) fetches the
 * current max version inside its transaction and delegates here, so the
 * row shape and defaults live in exactly one place.
 */

import { z } from "zod";

import {
  type ConsentVersionInsert,
  consentAttributionSchema,
  consentChannelSchema,
  consentSourceSchema,
  nextConsentVersion,
} from "./model.js";

export const grantConsentInputSchema = z.object({
  practiceId: z.uuid(),
  signalId: z.uuid(),
  /** NULL for practice-attested imports where we have no patient record. */
  patientId: z.uuid().nullish(),
  /** Subset of the consent channels; an empty grant is allowed but inert. */
  channels: z.array(consentChannelSchema),
  attribution: consentAttributionSchema,
  allowMinorEdits: z.boolean().optional(),
  grantedAt: z.date(),
  /**
   * Who is asserting this grant — the actor reference. `patient_link`
   * grants govern over staff-side sources forever (see `governingConsent`).
   */
  source: consentSourceSchema,
  expiresAt: z.date().nullish(),
});

export type GrantConsentInput = z.input<typeof grantConsentInputSchema>;

/**
 * Produce a new consent version row for a grant (or narrowing, or re-grant
 * after revocation). Never mutates or deletes prior rows — `consents` is
 * append-only, and `consent_version` increments past every existing
 * version (`nextConsentVersion`). Callers that only know the current max
 * version pass `[{ consentVersion: max }]`.
 *
 * Throws `ZodError` when the input does not validate.
 */
export function grantConsent(
  input: GrantConsentInput,
  existing: readonly { consentVersion: number }[] = [],
): ConsentVersionInsert {
  const parsed = grantConsentInputSchema.parse(input);
  return {
    practiceId: parsed.practiceId,
    signalId: parsed.signalId,
    patientId: parsed.patientId ?? null,
    channels: [...parsed.channels],
    attribution: parsed.attribution,
    allowMinorEdits: parsed.allowMinorEdits ?? false,
    grantedAt: parsed.grantedAt,
    source: parsed.source,
    consentVersion: nextConsentVersion(existing),
    revokedAt: null,
    expiresAt: parsed.expiresAt ?? null,
  };
}
