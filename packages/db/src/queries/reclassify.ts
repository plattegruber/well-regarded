/**
 * Manual reclassification writes (issue #93, Epic #11).
 *
 * Staff corrections are **append-only**: every correction INSERTs a new
 * `derivations` row with `basis: 'manual'`, `confidence: 1.0` ("a human
 * asserted this") and `model_version: NULL`. AI rows are never UPDATEd or
 * DELETEd — there is deliberately no update path for derivations anywhere
 * in this package. The current-derivation resolution
 * (`getCurrentDerivations` in ./derivations.js) ranks `manual` above every
 * inferred basis regardless of recency, so a correction is an override
 * with full history, and a later AI re-classification can never silently
 * undo it.
 *
 * Provider/location associations follow the representation the normalize
 * stage (#104) established on `signals`: a resolved association is the FK
 * (`provider_id` / `location_id`); an unresolved one is the
 * `provider_hint` / `location_hint` jsonb (`{ text, basis }`). A staff
 * confirm-or-correct sets the FK (or NULLs it for "none/unknown") and
 * rewrites the hint's `basis` to `'manual'` — the schema's sanctioned
 * "staff-entered" basis — so the association renders as confirmed, never
 * again as inferred.
 *
 * Every write here is one transaction: mutation + `audit_log` row commit
 * together (issue #93 requirement 7), same shape as
 * `resolveSuspectedDuplicate`.
 */

import type { Actor, DerivationDimension } from "@wellregarded/core";
import { and, desc, eq, sql } from "drizzle-orm";

import { audit, type Tx } from "../audit.js";
import type { Db } from "../client.js";
import { derivations } from "../schema/derivations.js";
import { type SignalEntityHint, signals } from "../schema/signals.js";
import { locations, providers } from "../schema/tenancy.js";
import type { Derivation } from "./derivations.js";
import type { Signal } from "./signals.js";

/** The current derivation for one (signal, dimension), inside any tx. */
async function currentDerivation(
  db: Db | Tx,
  signalId: string,
  dimension: DerivationDimension,
): Promise<Derivation | undefined> {
  const rows = await db
    .select()
    .from(derivations)
    .where(
      and(
        eq(derivations.signalId, signalId),
        eq(derivations.dimension, dimension),
      ),
    )
    // Same ordering `getCurrentDerivations` encodes: manual outranks
    // inferred regardless of recency; latest wins within a basis.
    .orderBy(
      sql`(${derivations.basis} = 'manual') DESC`,
      desc(derivations.createdAt),
    )
    .limit(1);
  return rows[0];
}

async function signalInPractice(
  db: Db | Tx,
  practiceId: string,
  signalId: string,
): Promise<Signal | undefined> {
  const rows = await db
    .select()
    .from(signals)
    .where(and(eq(signals.id, signalId), eq(signals.practiceId, practiceId)))
    .limit(1);
  return rows[0];
}

/** INSERT the manual row + its audit entry — the one sanctioned shape. */
async function insertManualDerivation(
  tx: Tx,
  input: {
    practiceId: string;
    signalId: string;
    dimension: DerivationDimension;
    value: string;
    previous: Derivation | undefined;
    actor: Actor;
    /** `confirmed` = the human blessed the current value unchanged. */
    kind: "confirmed" | "corrected";
  },
): Promise<Derivation> {
  const [row] = await tx
    .insert(derivations)
    .values({
      practiceId: input.practiceId,
      signalId: input.signalId,
      dimension: input.dimension,
      value: input.value,
      confidence: 1,
      basis: "manual",
      modelVersion: null,
      rationale: null,
    })
    .returning();
  if (!row) throw new Error("derivations insert returned no row");
  await audit(tx, {
    practiceId: input.practiceId,
    actor: input.actor,
    action: `derivation.${input.kind}`,
    entityType: "derivations",
    entityId: row.id,
    payload: {
      signalId: input.signalId,
      dimension: input.dimension,
      before: input.previous
        ? { value: input.previous.value, basis: input.previous.basis }
        : null,
      after: { value: input.value },
    },
  });
  return row;
}

export interface ReclassifyDerivationInput {
  practiceId: string;
  signalId: string;
  dimension: DerivationDimension;
  /** Must be in the dimension's canonical vocabulary — validate upstream
   * with `isDerivationValueForDimension` from `@wellregarded/core`. */
  value: string;
  /** Who corrected it — audited in the same transaction. */
  actor: Actor;
}

/**
 * Correct one dimension's judgment (issue #93): a NEW `basis: 'manual'`
 * row, the AI rows untouched. Returns the inserted row, or `undefined`
 * for a missing / cross-practice signal (double-submits of the same value
 * still insert — manual history is append-only and cheap; latest-manual
 * wins).
 */
export async function reclassifyDerivation(
  db: Db,
  input: ReclassifyDerivationInput,
): Promise<Derivation | undefined> {
  return db.transaction(async (tx) => {
    const signal = await signalInPractice(tx, input.practiceId, input.signalId);
    if (!signal) return undefined;
    const previous = await currentDerivation(
      tx,
      input.signalId,
      input.dimension,
    );
    return insertManualDerivation(tx, {
      practiceId: input.practiceId,
      signalId: input.signalId,
      dimension: input.dimension,
      value: input.value,
      previous,
      actor: input.actor,
      kind: previous?.value === input.value ? "confirmed" : "corrected",
    });
  });
}

export interface ConfirmDerivationInput {
  practiceId: string;
  signalId: string;
  dimension: DerivationDimension;
  actor: Actor;
}

/**
 * The one-click "was this right? ✓" write (issue #93 requirement 5): a
 * manual row asserting the CURRENT value, read server-side so the confirm
 * can never race a re-classification into confirming a value the human
 * did not see labeled as current. Returns `undefined` — a quiet no-op,
 * not an error — when there is nothing to confirm: no current judgment,
 * an already-manual one (stale double-click), or a missing signal.
 */
export async function confirmDerivation(
  db: Db,
  input: ConfirmDerivationInput,
): Promise<Derivation | undefined> {
  return db.transaction(async (tx) => {
    const signal = await signalInPractice(tx, input.practiceId, input.signalId);
    if (!signal) return undefined;
    const previous = await currentDerivation(
      tx,
      input.signalId,
      input.dimension,
    );
    if (!previous || previous.basis === "manual") return undefined;
    if (typeof previous.value !== "string") {
      // Structured judgments have no picker; confirming them is not a #93
      // surface. Quiet no-op rather than writing a shape we can't render.
      return undefined;
    }
    return insertManualDerivation(tx, {
      practiceId: input.practiceId,
      signalId: input.signalId,
      dimension: input.dimension,
      value: previous.value,
      previous,
      actor: input.actor,
      kind: "confirmed",
    });
  });
}

export type SignalAssociationKind = "provider" | "location";

export interface SetSignalAssociationInput {
  practiceId: string;
  signalId: string;
  kind: SignalAssociationKind;
  /** The confirmed provider/location id, or `null` for "none/unknown". */
  entityId: string | null;
  actor: Actor;
}

/**
 * Confirm or correct a provider/location association (issue #93
 * requirement 4): sets the signal's FK to the chosen entity (or NULL for
 * "none/unknown") and rewrites the hint with `basis: 'manual'` so the
 * association renders as staff-confirmed and an unresolved hint never
 * re-surfaces as inferred. Audited (`signal.association_confirmed` when
 * the value is blessed unchanged, `signal.association_corrected`
 * otherwise) in the same transaction.
 *
 * Returns the updated signal, or `undefined` for a missing /
 * cross-practice signal or an entity id outside the practice.
 */
export async function setSignalAssociation(
  db: Db,
  input: SetSignalAssociationInput,
): Promise<Signal | undefined> {
  return db.transaction(async (tx) => {
    const signal = await signalInPractice(tx, input.practiceId, input.signalId);
    if (!signal) return undefined;

    const isProvider = input.kind === "provider";
    const beforeId = isProvider ? signal.providerId : signal.locationId;
    const beforeHint = isProvider ? signal.providerHint : signal.locationHint;

    // The chosen entity must exist in this practice — an id from another
    // tenant reads the same as an unknown one.
    let entityName: string | null = null;
    if (input.entityId !== null) {
      const rows = isProvider
        ? await tx
            .select({ name: providers.displayName })
            .from(providers)
            .where(
              and(
                eq(providers.id, input.entityId),
                eq(providers.practiceId, input.practiceId),
              ),
            )
            .limit(1)
        : await tx
            .select({ name: locations.name })
            .from(locations)
            .where(
              and(
                eq(locations.id, input.entityId),
                eq(locations.practiceId, input.practiceId),
              ),
            )
            .limit(1);
      const entity = rows[0];
      if (!entity) return undefined;
      entityName = entity.name;
    }

    // The hint records what the association is based on: the source's own
    // text when a hint existed, else the staff-chosen name (`manual` is
    // the schema's "staff-entered" basis). "None" with no prior hint stays
    // hint-less — there is nothing to record.
    const hint: SignalEntityHint | null =
      input.entityId !== null
        ? { text: beforeHint?.text ?? entityName ?? "", basis: "manual" }
        : beforeHint
          ? { text: beforeHint.text, basis: "manual" }
          : null;

    const [updated] = await tx
      .update(signals)
      .set(
        isProvider
          ? {
              providerId: input.entityId,
              providerHint: hint,
              updatedAt: new Date(),
            }
          : {
              locationId: input.entityId,
              locationHint: hint,
              updatedAt: new Date(),
            },
      )
      .where(eq(signals.id, input.signalId))
      .returning();
    if (!updated) return undefined;

    const confirmed = beforeId !== null && beforeId === input.entityId;
    await audit(tx, {
      practiceId: input.practiceId,
      actor: input.actor,
      action: confirmed
        ? "signal.association_confirmed"
        : "signal.association_corrected",
      entityType: "signals",
      entityId: input.signalId,
      payload: {
        kind: input.kind,
        beforeId,
        afterId: input.entityId,
        hintText: hint?.text ?? beforeHint?.text ?? null,
        hintBasisBefore: beforeHint?.basis ?? null,
      },
    });
    return updated;
  });
}
