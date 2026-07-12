/**
 * `NormalizedSignal` — the wire contract every source adapter normalizes
 * into (issue #101, Epic #6).
 *
 * Mirrors the source-independent fields of the `signals` table
 * (`packages/db/src/schema/signals.ts`) WITHOUT importing the Drizzle types:
 * this is a wire contract crossing queue boundaries and must stay decoupled
 * from column changes. A drift guard in `signalsTableDrift.test.ts` asserts
 * the field mapping to `signals` columns still compiles.
 *
 * Everything is `z.strictObject` on purpose: a typo'd field in an adapter
 * must fail loudly in the contract suite, not silently drop data.
 */

import type { ConsentSource } from "@wellregarded/core";
import {
  DERIVATION_BASES,
  SIGNAL_VISIBILITIES,
  SOURCE_KINDS,
} from "@wellregarded/core";
import { z } from "zod";

/**
 * Annotation vocabulary for hints — the standard `basis` values shared with
 * `derivations` (`@wellregarded/core`): consumers can always distinguish "a
 * human said this" (`manual`) from "a model guessed this" (`inferred_*`).
 */
export const hintBasisSchema = z.enum(DERIVATION_BASES);

export type HintBasis = z.infer<typeof hintBasisSchema>;

/**
 * A provider/location hint: text plus how we know it — never an FK guess.
 * Entity resolution (hint text → `provider_id`/`location_id`) is the
 * normalize stage's job (#104), not the adapter's.
 */
export const entityHintSchema = z.strictObject({
  text: z.string().min(1),
  basis: hintBasisSchema,
});

export type EntityHint = z.infer<typeof entityHintSchema>;

/**
 * Optional patient contact carried alongside a signal — destined for the
 * `pii.patients` / `pii.contact_points` boundary downstream, never stored on
 * `signals` directly. At least one field must be present (an empty hint is a
 * bug, not a statement).
 */
export const patientHintSchema = z
  .strictObject({
    name: z.string().min(1).optional(),
    email: z.email().optional(),
    phone: z.string().min(1).optional(),
  })
  .refine(
    (hint) =>
      hint.name !== undefined ||
      hint.email !== undefined ||
      hint.phone !== undefined,
    { message: "patientHint must carry at least one of name/email/phone" },
  );

export type PatientHint = z.infer<typeof patientHintSchema>;

/**
 * Consent context a source can carry (manual entry, CSV). A subset of
 * `CONSENT_SOURCES` in `@wellregarded/core`: `patient_link` is excluded
 * because only the patient-link flow itself can produce it. The normalize
 * stage maps this hint; adapters never write `consents` rows.
 *
 * The `satisfies` clause is the drift guard: if core ever renames or drops
 * one of these values, this file stops compiling.
 */
export const SIGNAL_CONSENT_HINTS = [
  "practice_attested",
  "imported_unknown",
] as const satisfies readonly ConsentSource[];

export const consentHintSchema = z.enum(SIGNAL_CONSENT_HINTS);

export type ConsentHint = z.infer<typeof consentHintSchema>;

/**
 * Rating kept on the source's own scale, e.g. `{ value: 4, scale: 5 }` for a
 * 4-star Google review or `{ value: 9, scale: 10 }` for an NPS-style CSV
 * column. Deliberately NOT flattened to a 5-star float here: converting to a
 * canonical scale is normalize-stage policy (#104), and CSV scale detection
 * is Epic #8's job.
 */
export const ratingSchema = z
  .strictObject({
    value: z.number().finite().nonnegative(),
    scale: z.number().int().positive(),
  })
  .refine((rating) => rating.value <= rating.scale, {
    message: "rating value must not exceed its scale",
  });

export type NormalizedRating = z.infer<typeof ratingSchema>;

/**
 * Moderation states a source can report for an existing owner reply.
 * Vocabulary from Google's v4 `reviewReplyState` (owner replies are
 * moderated since 2026 — ADR 0002 §2), kept source-neutral here so a future
 * source with reply moderation reuses it.
 */
export const SOURCE_REPLY_STATES = ["PENDING", "REJECTED", "APPROVED"] as const;

/**
 * A pre-existing owner/practice response already published (or pending
 * moderation) AT THE SOURCE — e.g. a Google `reviewReply`. Carried so the
 * review inbox (Epic #10) can render "already replied on Google" instead of
 * prompting a fresh draft. Adapters only report this state; they never
 * write `responses` rows (Epic #10 decides how to import it).
 */
export const existingSourceReplySchema = z.strictObject({
  comment: z.string(),
  /** When the source says the reply was last changed (ISO datetime). */
  updateTime: z.iso.datetime({ offset: true }).optional(),
  /** The source's moderation verdict on the reply, when it reports one. */
  state: z.enum(SOURCE_REPLY_STATES).optional(),
  /** Rejection reason, when the source gives one (e.g. Google 2026-07). */
  policyViolation: z.string().optional(),
});

export type ExistingSourceReply = z.infer<typeof existingSourceReplySchema>;

/**
 * Structured source-context passthrough (issue #125, Epic #7) — an additive
 * optional extension of the wire contract:
 *
 * - `sourceUpdatedAt`: the source-reported last-update time. Edited reviews
 *   keep `occurredAt = createTime` (the experience happened then); the
 *   dedupe stage (#106) threads this value into
 *   `signal_versions.source_updated_at` when it records an edit.
 * - `existingReply`: see {@link existingSourceReplySchema}.
 *
 * NOTE: the `signals` table has no source-metadata column — this field
 * rides the wire contract for dedupe and Epic #10; persisting it is an
 * Epic #3 schema question, deliberately not invented here as a side channel.
 */
export const signalSourceMetadataSchema = z.strictObject({
  sourceUpdatedAt: z.iso.datetime({ offset: true }).optional(),
  existingReply: existingSourceReplySchema.optional(),
});

export type SignalSourceMetadata = z.infer<typeof signalSourceMetadataSchema>;

/**
 * The one shape every ingestion source converges on. See module doc; field
 * mapping to `signals` columns is pinned by `signalsTableDrift.test.ts`.
 */
export const normalizedSignalSchema = z.strictObject({
  /** `public` = visible at the source; `private` = internal-only feedback. */
  visibility: z.enum(SIGNAL_VISIBILITIES),
  /** When the patient experience happened (ISO datetime) — not when we ingested it. */
  occurredAt: z.iso.datetime({ offset: true }),
  /** Nullable — rating-only reviews exist. */
  originalText: z.string().nullable(),
  /** Nullable — sources without ratings exist. Kept on the source's scale. */
  rating: ratingSchema.nullable(),
  authorDisplayName: z.string().min(1).nullable(),
  authorExternalId: z.string().min(1).nullable(),
  /** Which adapter produced this — must equal the adapter's `sourceKind`. */
  sourceKind: z.enum(SOURCE_KINDS),
  /**
   * The source's native, stable ID (e.g. Google review name); null for
   * sources without one. Dedupe depends on this being stable across repeated
   * normalizations of the same artifact.
   */
  sourceId: z.string().min(1).nullable(),
  sourceUrl: z.url().nullable(),
  /** Optional patient contact — see {@link patientHintSchema}. */
  patientHint: patientHintSchema.optional(),
  /** Optional provider hint (text + basis, resolved to an FK in #104). */
  providerHint: entityHintSchema.optional(),
  /** Optional location hint (text + basis, resolved to an FK in #104). */
  locationHint: entityHintSchema.optional(),
  /** Optional consent context — see {@link consentHintSchema}. */
  consentHint: consentHintSchema.optional(),
  /** Optional source context — see {@link signalSourceMetadataSchema}. */
  sourceMetadata: signalSourceMetadataSchema.optional(),
});

export type NormalizedSignal = z.infer<typeof normalizedSignalSchema>;
