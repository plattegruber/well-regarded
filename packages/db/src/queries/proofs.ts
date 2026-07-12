/**
 * Proofs & placements queries (issue #96, Epic #13).
 *
 * Three entry points:
 *
 * - `publishableProofs` — THE canonical suitability query: the only
 *   sanctioned read path for serving proof (see its doc block).
 * - `suggestProof` — the route stage's write path: creates a `suggested`
 *   proof idempotently, audit row in the same transaction.
 * - `purgeTargetsForSignal` — the revocation purge contract's selects
 *   (issue #84's `revokeConsent` in ./consents.js calls it).
 * - `placementsForSignal` — the fuller signal → placements lookup (all
 *   placements with proof status) for the cascade UIs (issue #91).
 */

import type {
  Actor,
  ConsentAttribution,
  ConsentChannel,
  ConsentSource,
  RevocationPlacementRef,
  RevocationProofRef,
} from "@wellregarded/core";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";

import { audit, type Tx } from "../audit.js";
import type { Db } from "../client.js";
import { consents } from "../schema/consents.js";
import { proofExcerpts } from "../schema/proofExcerpts.js";
import { placements, proofs } from "../schema/proofs.js";
import { signals } from "../schema/signals.js";

/** A `proofs` row. */
export type Proof = typeof proofs.$inferSelect;
/** A `placements` row. */
export type Placement = typeof placements.$inferSelect;

export interface PublishableProofsFilters {
  /** Only proofs whose signal is tied to this location. */
  locationId?: string | undefined;
  /** Only proofs whose signal is tied to this provider. */
  providerId?: string | undefined;
  /** Recency window: only signals that occurred at/after this instant. */
  occurredSince?: Date | undefined;
  /** Restrict to excerpt-level proofs over these excerpts. */
  excerptIds?: readonly string[] | undefined;
  /**
   * The instant consent expiry is evaluated at — defaults to `new Date()`.
   * Injectable so tests pin it and callers batch consistently; mirrors the
   * `at` parameter of `checkConsent`.
   */
  now?: Date | undefined;
}

/** One publishable proof, with everything a serving surface needs. */
export interface PublishableProof {
  /** The `proofs` row. */
  proof: Proof;
  /**
   * What gets published: the proof's `display_text`, falling back to the
   * excerpt's verbatim text (excerpt-level) or the signal's original text
   * (whole-signal) where approval has not initialized it yet (#105).
   */
  displayText: string | null;
  /** The joined excerpt — NULL for whole-signal proofs. */
  excerpt: typeof proofExcerpts.$inferSelect | null;
  /** Original-reference fields off the parent signal (never copied). */
  signal: {
    id: string;
    occurredAt: Date;
    originalText: string | null;
    locationId: string | null;
    providerId: string | null;
    patientId: string | null;
  };
  /** The governing consent row the eligibility was computed from. */
  consent: {
    id: string;
    channels: ConsentChannel[];
    attribution: ConsentAttribution;
    allowMinorEdits: boolean;
    grantedAt: Date;
    source: ConsentSource;
    consentVersion: number;
    expiresAt: Date | null;
  };
}

/**
 * The canonical suitability query (issue #96): approved proofs whose
 * signal has consent to publish on `channel`, with their excerpt and
 * original-reference fields.
 *
 * **This is the ONLY sanctioned read path for serving proof.** The Proof
 * API search (Epic #14) composes on top of it; the proof library's
 * "publishable" filter (Epic #13) uses it. Any surface that serves proof
 * through a different query is a bug — the Epic #12 structural rule puts
 * consent gating in THIS query's joins, nowhere else.
 *
 * The consent join is `checkConsent` (`@wellregarded/core`, the ONE
 * publication gate — packages/db/CONSENT.md) encoded in SQL, predicate by
 * predicate (each is commented with the rule it mirrors below), and
 * test-locked against the core function by a property-style check in
 * `proofs.integration.test.ts`. If `checkConsent` changes, this query and
 * that test change with it.
 */
export async function publishableProofs(
  db: Db | Tx,
  practiceId: string,
  channel: ConsentChannel,
  filters: PublishableProofsFilters = {},
): Promise<PublishableProof[]> {
  if (filters.excerptIds !== undefined && filters.excerptIds.length === 0) {
    return [];
  }
  const now = filters.now ?? new Date();

  // `checkConsent`'s governingConsent: rows are partitioned by source
  // first — a `patient_link` row, if any exists, ALWAYS beats the
  // staff-side sources (a patient's decision can never be overridden by
  // staff, in either direction); within the winning partition the highest
  // `consent_version` is the complete current state. Earlier versions —
  // and every staff row under a patient row — are history, never
  // consulted. Revocations are rows too (issue #84), so a governing
  // revocation surfaces here with `revoked_at` set.
  const governing = db
    .selectDistinctOn([consents.signalId], {
      signalId: consents.signalId,
      id: consents.id,
      channels: consents.channels,
      attribution: consents.attribution,
      allowMinorEdits: consents.allowMinorEdits,
      grantedAt: consents.grantedAt,
      source: consents.source,
      consentVersion: consents.consentVersion,
      revokedAt: consents.revokedAt,
      expiresAt: consents.expiresAt,
    })
    .from(consents)
    .where(eq(consents.practiceId, practiceId))
    .orderBy(
      consents.signalId,
      sql`(${consents.source} = 'patient_link') DESC`,
      desc(consents.consentVersion),
    )
    .as("governing_consent");

  const conditions = [
    eq(proofs.practiceId, practiceId),
    // Only human-approved proofs ever serve; `suggested` and `archived`
    // are invisible to every serving surface.
    eq(proofs.status, "approved"),
    filters.locationId === undefined
      ? undefined
      : eq(signals.locationId, filters.locationId),
    filters.providerId === undefined
      ? undefined
      : eq(signals.providerId, filters.providerId),
    filters.occurredSince === undefined
      ? undefined
      : gte(signals.occurredAt, filters.occurredSince),
    filters.excerptIds === undefined
      ? undefined
      : inArray(proofs.excerptId, [...filters.excerptIds]),
  ].filter((condition) => condition !== undefined);

  const rows = await db
    .select({
      proof: proofs,
      displayText: sql<
        string | null
      >`coalesce(${proofs.displayText}, ${proofExcerpts.excerptText}, ${signals.originalText})`,
      excerpt: proofExcerpts,
      signal: {
        id: signals.id,
        occurredAt: signals.occurredAt,
        originalText: signals.originalText,
        locationId: signals.locationId,
        providerId: signals.providerId,
        patientId: signals.patientId,
      },
      consent: {
        id: governing.id,
        channels: governing.channels,
        attribution: governing.attribution,
        allowMinorEdits: governing.allowMinorEdits,
        grantedAt: governing.grantedAt,
        source: governing.source,
        consentVersion: governing.consentVersion,
        expiresAt: governing.expiresAt,
      },
    })
    .from(proofs)
    .innerJoin(signals, eq(proofs.signalId, signals.id))
    .leftJoin(proofExcerpts, eq(proofs.excerptId, proofExcerpts.id))
    // The consent gate. INNER: `checkConsent`'s `no_consent` — a signal
    // with no consent rows never serves.
    .innerJoin(
      governing,
      and(
        eq(governing.signalId, proofs.signalId),
        // `revoked`: publishable iff the governing row is not a
        // revocation (revocations are rows carrying `revoked_at`).
        isNull(governing.revokedAt),
        // `expired`: publishable iff expires_at IS NULL or > `at`
        // (exclusive — a grant is dead the instant it expires).
        or(isNull(governing.expiresAt), gt(governing.expiresAt, now)),
        // `channel_not_granted`: publishable iff channel ∈ channels.
        sql`${channel} = ANY(${governing.channels})`,
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(signals.occurredAt), desc(proofs.createdAt));

  return rows;
}

export interface SuggestProofInput {
  practiceId: string;
  signalId: string;
  /** Who suggested — the route stage passes its system actor. */
  actor: Actor;
  /**
   * References and non-PII context recorded on the `proof.suggested`
   * audit row (e.g. sentiment, suitability confidence, import run id).
   */
  auditPayload?: Record<string, unknown> | undefined;
}

export interface SuggestProofResult {
  /** False when an existing non-archived proof made this a no-op. */
  created: boolean;
  proof?: Proof;
}

/**
 * Create a whole-signal `suggested` proof — the route stage's proof sink
 * (issue #108's `ProofSink` contract, implemented by #96). Excerpt
 * extraction and `display_text` initialization are later Epic #13 work;
 * this row only marks "worth considering".
 *
 * Idempotent per signal: when ANY non-archived proof already exists for
 * `signalId` (whole-signal or excerpt-level), nothing is created — queue
 * re-delivery and re-classification never stack suggestions. Archived
 * proofs do not block: archiving retires a decision, and a signal that
 * routes as a candidate again may be suggested afresh. The partial unique
 * index `proofs_signal_whole_live_uniq` backstops races.
 *
 * Audits `proof.suggested` (entity `proofs`, the new row's id) in the
 * same transaction as the insert; accepts a `Tx` so the route store's
 * single routing transaction covers row + audit + stats atomically.
 */
export async function suggestProof(
  db: Db | Tx,
  input: SuggestProofInput,
): Promise<SuggestProofResult> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: proofs.id })
      .from(proofs)
      .where(
        and(eq(proofs.signalId, input.signalId), ne(proofs.status, "archived")),
      )
      .limit(1);
    if (existing.length > 0) return { created: false };

    const [row] = await tx
      .insert(proofs)
      .values({
        practiceId: input.practiceId,
        signalId: input.signalId,
        excerptId: null,
        status: "suggested",
      })
      // A concurrent suggestion losing the race on the partial unique
      // index is the same no-op as the probe finding a row.
      .onConflictDoNothing()
      .returning();
    if (!row) return { created: false };

    await audit(tx, {
      practiceId: input.practiceId,
      actor: input.actor,
      action: "proof.suggested",
      entityType: "proofs",
      entityId: row.id,
      ...(input.auditPayload ? { payload: input.auditPayload } : {}),
    });
    return { created: true, proof: row };
  });
}

/**
 * The purge contract for a revocation (issues #84 → #91): every proof
 * derived from `signalId`, and those proofs' ACTIVE placements. This is
 * the query `revokeConsent` in ./consents.js runs (inside its
 * transaction) to fill the `affectedProofIds`/`affectedPlacementIds` it
 * returns — the shapes are the structural ref types from
 * `@wellregarded/core` (`RevocationProofRef`, `RevocationPlacementRef`).
 */
export async function purgeTargetsForSignal(
  db: Db | Tx,
  signalId: string,
): Promise<{
  proofs: RevocationProofRef[];
  placements: RevocationPlacementRef[];
}> {
  const proofRefs = await db
    .select({ id: proofs.id, signalId: proofs.signalId })
    .from(proofs)
    .where(eq(proofs.signalId, signalId));
  if (proofRefs.length === 0) return { proofs: [], placements: [] };
  const placementRefs = await db
    .select({ id: placements.id, proofId: placements.proofId })
    .from(placements)
    .where(
      and(
        inArray(
          placements.proofId,
          proofRefs.map((ref) => ref.id),
        ),
        eq(placements.active, true),
      ),
    );
  return { proofs: proofRefs, placements: placementRefs };
}

/** One placement of a proof of the given signal. */
export interface SignalPlacement {
  placement: Placement;
  proofId: string;
  proofStatus: Proof["status"];
}

/**
 * Every placement of every proof of `signalId`, active or not, with each
 * proof's id and status — the fuller signal → placements lookup for the
 * revocation-cascade surfaces (issue #91 deactivates the active ones with
 * reason `PLACEMENT_DEACTIVATION_CONSENT_REVOKED`; the bare id lists the
 * revocation itself returns come from `purgeTargetsForSignal` above).
 * Accepts a `Tx` so the cascade can run inside the revocation's
 * transaction.
 */
export async function placementsForSignal(
  db: Db | Tx,
  signalId: string,
): Promise<SignalPlacement[]> {
  return db
    .select({
      placement: placements,
      proofId: proofs.id,
      proofStatus: proofs.status,
    })
    .from(placements)
    .innerJoin(proofs, eq(placements.proofId, proofs.id))
    .where(eq(proofs.signalId, signalId))
    .orderBy(desc(placements.activatedAt));
}
