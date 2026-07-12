/**
 * Manual single-signal entry (issue #138, Epic #8) — the zod contract the
 * dashboard form and `POST /api/signals/manual` (workers/api) share, so
 * the two front doors cannot drift. The validated payload becomes the raw
 * artifact of a one-row `manual` import run and flows through the standard
 * pipeline (adapter in `@wellregarded/sources`, `manual/` module) — NEVER
 * a direct `signals` insert: classification, dedupe, routing, and
 * provenance must apply to a typed-in compliment exactly as they do to an
 * imported one.
 */

import { z } from "zod";

import { CONSENT_CHANNELS } from "./consent/index.js";

/**
 * Suggestion chips for the source-description field — a static starter
 * list, deliberately not a taxonomy: the field stores free text verbatim
 * as the human-readable provenance; we can mine the values later.
 */
export const MANUAL_SOURCE_SUGGESTIONS = [
  "patient email",
  "phone call",
  "in person",
  "card/letter",
] as const;

/**
 * How far past "today in UTC" a date may sit and still count as today:
 * a front desk in UTC+14 entering today's compliment is not entering a
 * future date. Anything beyond this skew is a real future date — rejected.
 */
const TIMEZONE_GRACE_MS = 14 * 60 * 60 * 1000;

function isNotFutureDate(isoDate: string): boolean {
  const parsed = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isFinite(parsed) && parsed <= Date.now() + TIMEZONE_GRACE_MS;
}

/**
 * The inline consent capture: `unknown` ("No / Not asked") records
 * NOTHING downstream — the absence of a `consents` row IS the state —
 * while `practice_attested` must say where the permission may be used
 * (channels) and where it lives (the note), and produces a real
 * `consents` row through the pipeline's consent seam.
 */
export const manualConsentSchema = z.discriminatedUnion("choice", [
  z.strictObject({ choice: z.literal("unknown") }),
  z.strictObject({
    choice: z.literal("practice_attested"),
    channels: z
      .array(z.enum(CONSENT_CHANNELS))
      .min(1, "Pick at least one place the permission covers."),
    note: z
      .string()
      .trim()
      .min(1, "Say where the permission lives (who said yes, when, to whom)."),
  }),
]);

export type ManualConsent = z.infer<typeof manualConsentSchema>;

/**
 * Optional patient identity — destined for the `pii.*` schema via the
 * pipeline's `patientHint` seam (never stored on `signals`). All-empty is
 * simply "no patient attached"; callers should omit the object then.
 */
export const manualPatientSchema = z
  .strictObject({
    name: z.string().trim().min(1).optional(),
    email: z.email().optional(),
    phone: z.string().trim().min(1).optional(),
  })
  .refine(
    (patient) =>
      patient.name !== undefined ||
      patient.email !== undefined ||
      patient.phone !== undefined,
    { message: "Provide a name, email, or phone — or leave the patient off." },
  );

export type ManualPatient = z.infer<typeof manualPatientSchema>;

/**
 * The full form payload. NOTE the deliberate absence of a visibility
 * field: manual entries are `private` feedback at M1 — a public toggle is
 * deliberately omitted (issue #138 requirement 1); the adapter pins
 * `visibility: "private"`.
 */
export const manualSignalFormSchema = z.strictObject({
  /** What the patient said — the signal's original text. */
  text: z.string().trim().min(1, "Enter what the patient said."),
  /** Calendar date of the experience (YYYY-MM-DD); today or earlier. */
  occurredOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date as YYYY-MM-DD.")
    .refine(isNotFutureDate, {
      message: "The date can't be in the future.",
    }),
  /** Free-text provenance ("phone call", "patient email"), stored verbatim. */
  sourceDescription: z
    .string()
    .trim()
    .min(1, "Say where this came from — for example, a phone call."),
  /** Optional structured choices; validated against the practice server-side. */
  locationId: z.uuid().optional(),
  providerId: z.uuid().optional(),
  patient: manualPatientSchema.optional(),
  consent: manualConsentSchema,
});

export type ManualSignalForm = z.infer<typeof manualSignalFormSchema>;
