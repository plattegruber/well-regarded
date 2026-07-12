/**
 * Today-queue reads (issue #95, Epic #11): one helper per card condition,
 * fired concurrently by the /today loader (`Promise.all` — no waterfall).
 *
 * Each capped helper returns `{ items, total }` so the queue can render
 * up to `limit` cards plus an accurate "N more →" link into the owning
 * surface. Conditions whose backing tables do not exist yet (recovery
 * items — Epic #15/#122; responses and publishes — Epic #10 #80/#82) have
 * no helper here; the loader documents them as deferred and renders
 * nothing, so Today ships and degrades honestly whatever lands first.
 */

import {
  REVIEW_SOURCE_KINDS,
  type SignalVisibility,
  type SourceKind,
  type UrgencyLevel,
} from "@wellregarded/core";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { Tx } from "../audit.js";
import type { Db } from "../client.js";
import { signalVersions } from "../schema/dedupe.js";
import { derivations } from "../schema/derivations.js";
import { importRuns } from "../schema/importRuns.js";
import { signals } from "../schema/signals.js";
import { sourceConnections } from "../schema/sourceConnections.js";
import type { ImportRun } from "./importRuns.js";
import type { SourceConnection } from "./sourceConnections.js";

/** A capped card list plus the true count behind it ("N more →"). */
export interface TodaySection<T> {
  items: T[];
  total: number;
}

/** Default per-category card cap (issue #95 requirement 3). */
export const TODAY_SECTION_LIMIT = 5;

// ---------------------------------------------------------------------------
// Connections needing re-auth (Epic #7)
// ---------------------------------------------------------------------------

/**
 * Integrations in `needs_reauth` — always the queue's first card:
 * everything downstream silently degrades while a connection is broken.
 * One connection per kind exists today, so no cap.
 */
export async function listReauthConnections(
  db: Db | Tx,
  practiceId: string,
): Promise<SourceConnection[]> {
  return db
    .select()
    .from(sourceConnections)
    .where(
      and(
        eq(sourceConnections.practiceId, practiceId),
        eq(sourceConnections.status, "needs_reauth"),
      ),
    )
    .orderBy(asc(sourceConnections.kind));
}

// ---------------------------------------------------------------------------
// Urgent signals (interim for Epic #15's recovery items)
// ---------------------------------------------------------------------------

/**
 * TODO(#122): replace with urgent **recovery items** (unassigned /
 * overdue) once the `recovery_items` table lands. Until then the route
 * stage (#108) only audits `signal.routed_urgent`, so the live truth is
 * the signal's CURRENT urgency derivation: high/critical means a human
 * should look. Manual reclassification (#93) downgrading the urgency
 * clears the card — the interim "resolve" path.
 */
export interface UrgentSignalCard {
  id: string;
  sourceKind: SourceKind;
  visibility: SignalVisibility;
  occurredAt: Date;
  /** Current text (latest version wins), for the card's one-line quote. */
  text: string | null;
  urgency: UrgencyLevel;
}

const URGENT_LEVELS: readonly string[] = ["high", "critical"];

export async function listUrgentSignals(
  db: Db | Tx,
  params: {
    practiceId: string;
    /** Without `view_private_feedback`, private urgencies stay unseen. */
    viewPrivateFeedback: boolean;
    limit?: number;
  },
): Promise<TodaySection<UrgentSignalCard>> {
  const limit = params.limit ?? TODAY_SECTION_LIMIT;
  // Current urgency per signal — same DISTINCT ON ordering as
  // getCurrentDerivations (manual outranks inferred, then recency).
  const cu = db
    .selectDistinctOn([derivations.signalId], {
      signalId: derivations.signalId,
      value: derivations.value,
    })
    .from(derivations)
    .where(
      and(
        eq(derivations.practiceId, params.practiceId),
        eq(derivations.dimension, "urgency"),
      ),
    )
    .orderBy(
      derivations.signalId,
      sql`(${derivations.basis} = 'manual') DESC`,
      desc(derivations.createdAt),
    )
    .as("cu");

  const urgencyText = sql<string>`${cu.value} #>> '{}'`;
  const conditions = and(
    eq(signals.practiceId, params.practiceId),
    eq(signals.retentionState, "active"),
    inArray(urgencyText, [...URGENT_LEVELS]),
    ...(params.viewPrivateFeedback ? [] : [eq(signals.visibility, "public")]),
  );

  const [rows, counts] = await Promise.all([
    db
      .select({
        id: signals.id,
        sourceKind: signals.sourceKind,
        visibility: signals.visibility,
        occurredAt: signals.occurredAt,
        originalText: signals.originalText,
        currentVersionId: signals.currentVersionId,
        versionContent: signalVersions.content,
        urgency: urgencyText,
      })
      .from(signals)
      .innerJoin(cu, eq(cu.signalId, signals.id))
      .leftJoin(signalVersions, eq(signalVersions.id, signals.currentVersionId))
      .where(conditions)
      // Severity desc (critical first), oldest first within severity —
      // the issue-#95 ordering for urgent items.
      .orderBy(
        sql`(${urgencyText} = 'critical') DESC`,
        asc(signals.occurredAt),
        asc(signals.id),
      )
      .limit(limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(signals)
      .innerJoin(cu, eq(cu.signalId, signals.id))
      .where(conditions),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      sourceKind: row.sourceKind,
      visibility: row.visibility,
      occurredAt: row.occurredAt,
      text:
        row.currentVersionId !== null ? row.versionContent : row.originalText,
      urgency: row.urgency as UrgencyLevel,
    })),
    total: counts[0]?.total ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Negative reviews needing response (Epic #10 tier 1)
// ---------------------------------------------------------------------------

export interface NegativeReviewCard {
  id: string;
  sourceKind: SourceKind;
  occurredAt: Date;
  /** Current text (latest version wins). */
  text: string | null;
  /** Current rating (source scale, numeric string) or null. */
  rating: string | null;
  sentiment: string | null;
}

/**
 * Public reviews (the #76 review predicate: `visibility = 'public'` AND
 * `source_kind` in `REVIEW_SOURCE_KINDS`) matching the tier-1 negative
 * predicate — rating ≤ 2 or current `negative` sentiment — **oldest
 * first** (the longer it waits, the worse it looks). The SQL mirrors
 * `isNegativeReview` in `@wellregarded/core`, the same mirror
 * `reviewsInbox.ts` uses for its tier-1 ordering; the integration test
 * asserts SQL and function agree row-for-row.
 *
 * TODO(#80): once the `responses` table (Epic #10) lands, exclude
 * reviews that already have a response — swap in the same
 * latest-response join as `latestResponseStatusExpr` in
 * `reviewsInbox.ts`. Today no responses can exist, so every match still
 * needs one.
 */
export async function listNegativeReviewsNeedingResponse(
  db: Db | Tx,
  params: { practiceId: string; limit?: number },
): Promise<TodaySection<NegativeReviewCard>> {
  const limit = params.limit ?? TODAY_SECTION_LIMIT;
  const cs = db
    .selectDistinctOn([derivations.signalId], {
      signalId: derivations.signalId,
      value: derivations.value,
    })
    .from(derivations)
    .where(
      and(
        eq(derivations.practiceId, params.practiceId),
        eq(derivations.dimension, "sentiment"),
      ),
    )
    .orderBy(
      derivations.signalId,
      sql`(${derivations.basis} = 'manual') DESC`,
      desc(derivations.createdAt),
    )
    .as("cs");

  // Current rating: the latest version's rating wins when one was recorded.
  const currentRating = sql<
    string | null
  >`CASE WHEN ${signals.currentVersionId} IS NOT NULL AND ${signalVersions.rating} IS NOT NULL THEN ${signalVersions.rating} ELSE ${signals.originalRating} END`;
  const sentimentText = sql<string | null>`${cs.value} #>> '{}'`;
  const conditions = and(
    eq(signals.practiceId, params.practiceId),
    eq(signals.visibility, "public"),
    inArray(signals.sourceKind, [...REVIEW_SOURCE_KINDS]),
    eq(signals.retentionState, "active"),
    sql`(${currentRating} <= 2 OR ${sentimentText} = 'negative')`,
  );

  const base = () =>
    db
      .select({
        id: signals.id,
        sourceKind: signals.sourceKind,
        occurredAt: signals.occurredAt,
        originalText: signals.originalText,
        currentVersionId: signals.currentVersionId,
        versionContent: signalVersions.content,
        rating: currentRating,
        sentiment: sentimentText,
      })
      .from(signals)
      .leftJoin(signalVersions, eq(signalVersions.id, signals.currentVersionId))
      .leftJoin(cs, eq(cs.signalId, signals.id))
      .where(conditions);

  const [rows, counts] = await Promise.all([
    base().orderBy(asc(signals.occurredAt), asc(signals.id)).limit(limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(signals)
      .leftJoin(signalVersions, eq(signalVersions.id, signals.currentVersionId))
      .leftJoin(cs, eq(cs.signalId, signals.id))
      .where(conditions),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      sourceKind: row.sourceKind,
      occurredAt: row.occurredAt,
      text:
        row.currentVersionId !== null ? row.versionContent : row.originalText,
      rating: row.rating,
      sentiment: row.sentiment,
    })),
    total: counts[0]?.total ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Imports (Epics #6/#8)
// ---------------------------------------------------------------------------

/** Failed import runs — action cards, newest failure first. */
export async function listFailedImports(
  db: Db | Tx,
  params: { practiceId: string; limit?: number },
): Promise<TodaySection<ImportRun>> {
  return importRunsByStatus(db, params, "failed");
}

/** Currently-running import runs — informational cards, always last. */
export async function listRunningImports(
  db: Db | Tx,
  params: { practiceId: string; limit?: number },
): Promise<TodaySection<ImportRun>> {
  return importRunsByStatus(db, params, "running");
}

async function importRunsByStatus(
  db: Db | Tx,
  params: { practiceId: string; limit?: number },
  status: "failed" | "running",
): Promise<TodaySection<ImportRun>> {
  const limit = params.limit ?? TODAY_SECTION_LIMIT;
  const conditions = and(
    eq(importRuns.practiceId, params.practiceId),
    eq(importRuns.status, status),
  );
  const [items, counts] = await Promise.all([
    db
      .select()
      .from(importRuns)
      .where(conditions)
      .orderBy(desc(importRuns.startedAt), desc(importRuns.id))
      .limit(limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(importRuns)
      .where(conditions),
  ]);
  return { items, total: counts[0]?.total ?? 0 };
}
