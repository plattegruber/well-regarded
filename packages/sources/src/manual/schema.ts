/**
 * The manual-entry raw-artifact envelope (issue #138, Epic #8) — the
 * contract between `POST /api/signals/manual` (workers/api), which stores
 * the validated form payload as a raw artifact, and the `manual`
 * SourceAdapter (./adapter.ts), mirroring the CSV batch envelope precedent
 * (../csv/schema.ts).
 *
 * One stored artifact = one typed-in signal. Everything normalization
 * needs rides the envelope:
 *
 * ```jsonc
 * {
 *   "kind": "manual.entry",        // discriminator, always this
 *   "envelopeVersion": 1,          // bump on breaking change
 *   "practiceId": "<uuid>",        // tenant provenance
 *   "sourceId": "<uuid>",          // minted at SUBMISSION time and embedded
 *   //   here, so re-normalizing the same artifact is idempotent (the
 *   //   `(practice_id, source_kind, source_id)` unique constraint absorbs
 *   //   re-deliveries) — never minted during normalize
 *   "enteredBy": "<staff uuid>",   // who typed it in (audit + consent actor)
 *   "enteredAt": "<ISO datetime>", // when it was submitted
 *   "entry": {                     // the validated form payload
 *     "text": "...", "occurredAt": "<ISO datetime>",
 *     "sourceDescription": "phone call",   // verbatim human provenance
 *     "locationName": "...",       // optional — NAMES, not FKs: structured
 *     "providerName": "...",       //   choices land as hints with
 *     //   basis "manual" and resolve back to FKs in the normalize stage
 *     "patient": { "name": "...", "email": "...", "phone": "..." },
 *     "consent": { "choice": "unknown" }   // or practice_attested +
 *   }                              //   channels + note
 * }
 * ```
 *
 * Strict schemas throughout: we author every byte of this envelope, so an
 * unknown field is a bug on our side and must fail loudly. A degenerate
 * artifact (`entry: null`) normalizes to `[]` per the adapter contract.
 */

import { CONSENT_CHANNELS } from "@wellregarded/core";
import { z } from "zod";

export const MANUAL_ENTRY_KIND = "manual.entry";

export const MANUAL_ENTRY_ENVELOPE_VERSION = 1;

const manualEntryConsentSchema = z.discriminatedUnion("choice", [
  z.strictObject({ choice: z.literal("unknown") }),
  z.strictObject({
    choice: z.literal("practice_attested"),
    channels: z.array(z.enum(CONSENT_CHANNELS)).min(1),
    note: z.string().min(1),
  }),
]);

const manualEntryPatientSchema = z
  .strictObject({
    name: z.string().min(1).optional(),
    email: z.email().optional(),
    phone: z.string().min(1).optional(),
  })
  .refine(
    (patient) =>
      patient.name !== undefined ||
      patient.email !== undefined ||
      patient.phone !== undefined,
    { message: "an empty patient object is a bug — omit it instead" },
  );

const manualEntryBodySchema = z.strictObject({
  text: z.string().min(1),
  /** When the experience happened (ISO datetime) — not when it was typed in. */
  occurredAt: z.iso.datetime({ offset: true }),
  /** Free-text provenance, stored verbatim ("phone call", "card/letter"). */
  sourceDescription: z.string().min(1),
  locationName: z.string().min(1).optional(),
  providerName: z.string().min(1).optional(),
  patient: manualEntryPatientSchema.optional(),
  consent: manualEntryConsentSchema,
});

export const manualEntryArtifactSchema = z.strictObject({
  kind: z.literal(MANUAL_ENTRY_KIND),
  envelopeVersion: z.literal(MANUAL_ENTRY_ENVELOPE_VERSION),
  practiceId: z.uuid(),
  /** Minted at submission time — see module doc. */
  sourceId: z.uuid(),
  /** Staff member who entered the signal. */
  enteredBy: z.uuid(),
  enteredAt: z.iso.datetime({ offset: true }),
  /** Null is the degenerate artifact — normalizes to `[]`, never throws. */
  entry: manualEntryBodySchema.nullable(),
});

export type ManualEntryArtifact = z.infer<typeof manualEntryArtifactSchema>;

export type ManualEntryBody = NonNullable<ManualEntryArtifact["entry"]>;

/** Builder the submission endpoint uses — one place owns the literals. */
export function buildManualEntryArtifact(input: {
  practiceId: string;
  sourceId: string;
  enteredBy: string;
  enteredAt: string;
  entry: ManualEntryBody;
}): ManualEntryArtifact {
  return {
    kind: MANUAL_ENTRY_KIND,
    envelopeVersion: MANUAL_ENTRY_ENVELOPE_VERSION,
    ...input,
  };
}
