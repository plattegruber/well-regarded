/**
 * Review inbox reads (issues #76/#77, Epic #10): the response-workspace
 * list (`listReviewInbox`), its counted-tab aggregates
 * (`countReviewInboxStatuses`), and the detail assembly
 * (`getReviewDetail`).
 *
 * Reviews ARE signals: `visibility = 'public'` AND `source_kind` in
 * `REVIEW_SOURCE_KINDS` (`@wellregarded/core`) — no reviews table, no
 * inbox-state column (#76: "not a status column on signals").
 *
 * **Response-status resolution** happens in ONE place:
 * {@link latestResponseStatusExpr} is the SQL source of the latest
 * `responses.status` per signal, and the CASE in
 * {@link responseStatusExpr} mirrors `reviewStatusFromResponseState`
 * (`@wellregarded/core`) onto the inbox vocabulary. The status reads the
 * newest `responses` row per signal (#80's table); a review with no
 * response rows resolves through the documented fallback: **no response
 * recorded → `needs_response`**.
 *
 * **Needs-attention-first ordering** (#76, the default sort) is a SQL CASE
 * tier plus a per-tier direction:
 *
 *   1. Unresponded negative (rating ≤ 2 OR current sentiment `negative`),
 *      oldest `occurred_at` first — the longer a bad review sits
 *      unanswered, the worse it reads.
 *   2. Unresponded mixed sentiment, oldest first.
 *   3. Unresponded rest, newest first.
 *   4. Drafted / pending approval, newest first.
 *   5. Responded, newest first.
 *
 * The mixed ASC/DESC directions collapse into one keyset-friendly ordering
 * by negating the epoch for DESC tiers: ORDER BY (tier, sort_key, id) all
 * ascending, where sort_key = epoch(occurred_at) for tiers 1–2 and
 * −epoch(occurred_at) for tiers 3–5. Cursors encode the exact
 * (tier, sort_key, id) tuple the row was emitted with, so pagination walks
 * tier boundaries without dupes or gaps. `sort: "newest"` overrides with
 * plain `occurred_at DESC, id DESC`.
 *
 * The negative predicate in tier 1 is the SQL mirror of
 * `isNegativeReview` (`@wellregarded/core`) — #80's approval gating uses
 * the same function; change both together.
 */

import {
  REVIEW_SOURCE_KINDS,
  type ResponseErrorDetail,
  type ResponseModerationState,
  type ReviewResponseStatus,
  type ReviewSourceKind,
  reviewStatusFromResponseState,
  type SentimentFilter,
  type SignalAvailability,
} from "@wellregarded/core";
import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { Tx } from "../audit.js";
import type { Db } from "../client.js";
import { signalVersions } from "../schema/dedupe.js";
import { responses } from "../schema/responses.js";
import { signals } from "../schema/signals.js";
import { locations, providers } from "../schema/tenancy.js";
import {
  type CurrentDerivations,
  getCurrentDerivations,
} from "./derivations.js";
import { listResponsesForSignal } from "./responses.js";
import type { Signal } from "./signals.js";
import {
  currentDimensionSubquery,
  type SignalListJudgment,
} from "./signalsInbox.js";

/** The inbox's URL-param filters (issue #76), all combined with AND. */
export interface ReviewInboxFilters {
  source?: ReviewSourceKind;
  locationId?: string;
  /** Whole-star buckets, 1–5, multi-select; 4.5 counts as 4. */
  ratings?: number[];
  /** Derived from the latest response row — see the module doc. */
  status?: ReviewResponseStatus;
  /** Current-derivation sentiment; `unclassified` = no sentiment row. */
  sentiment?: SentimentFilter;
}

export type ReviewInboxSort = "attention" | "newest";

export interface ReviewInboxItem {
  id: string;
  sourceKind: ReviewSourceKind;
  availability: SignalAvailability;
  occurredAt: Date;
  /** Current text — the latest recorded version wins over the original. */
  text: string | null;
  /** Current rating on the source's own scale (numeric string, e.g. "4.0"). */
  rating: string | null;
  locationName: string | null;
  providerName: string | null;
  sentiment: SignalListJudgment | null;
  /** Current response-risk derivation — the inbox's red-outline marker. */
  responseRisk: SignalListJudgment | null;
  status: ReviewResponseStatus;
}

export interface ListReviewInboxParams {
  practiceId: string;
  filters?: ReviewInboxFilters;
  sort?: ReviewInboxSort;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string | null;
  /** Page size; defaults to 25. */
  limit?: number;
}

export interface ReviewInboxPage {
  items: ReviewInboxItem[];
  nextCursor: string | null;
}

export const REVIEWS_PAGE_SIZE = 25;

/**
 * Keyset cursor payloads, one per sort mode (`m` discriminates; a cursor
 * minted under the other sort reads as page one, not a database error).
 * Opaque base64url over JSON.
 */
type ReviewsCursor =
  | { m: "a"; x: number; k: number; i: string }
  | { m: "n"; t: string; i: string };

function encodeReviewsCursor(payload: ReviewsCursor): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `null` for anything malformed or from the other sort mode. */
export function decodeReviewsCursor(
  cursor: string | null | undefined,
  sort: ReviewInboxSort,
): ReviewsCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as ReviewsCursor;
    if (parsed.m === "a" && sort === "attention") {
      if (
        typeof parsed.x !== "number" ||
        !Number.isFinite(parsed.x) ||
        typeof parsed.k !== "number" ||
        !Number.isFinite(parsed.k) ||
        typeof parsed.i !== "string" ||
        !UUID_RE.test(parsed.i)
      ) {
        return null;
      }
      return { m: "a", x: parsed.x, k: parsed.k, i: parsed.i };
    }
    if (parsed.m === "n" && sort === "newest") {
      if (
        typeof parsed.t !== "string" ||
        Number.isNaN(Date.parse(parsed.t)) ||
        typeof parsed.i !== "string" ||
        !UUID_RE.test(parsed.i)
      ) {
        return null;
      }
      return { m: "n", t: parsed.t, i: parsed.i };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The latest `responses.status` for each signal — the #80 seam, now over
 * the real table: a correlated newest-first pick of the signal's
 * `responses` rows (`created_at DESC, id DESC` — the same order the #77
 * thread renders), NULL when no response exists so the status CASE
 * resolves to the documented fallback, `needs_response`. Everything else
 * in this module reads through {@link responseStatusExpr} unchanged.
 * Correlated-per-row is fine at inbox page size (25 rows); the
 * `responses_signal_id_created_at_idx` index serves the pick.
 */
function latestResponseStatusExpr(): SQL<string | null> {
  return sql<string | null>`(
    SELECT r.status::text FROM ${responses} r
    WHERE r.signal_id = ${signals.id}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT 1
  )`;
}

/**
 * SQL mirror of `reviewStatusFromResponseState` (`@wellregarded/core`) —
 * keep the two in lockstep (the core function documents the mapping).
 */
function responseStatusExpr(
  latest: SQL<string | null>,
): SQL<ReviewResponseStatus> {
  return sql<ReviewResponseStatus>`CASE
    WHEN ${latest} IS NULL THEN 'needs_response'
    WHEN ${latest} = 'draft' THEN 'drafted'
    WHEN ${latest} IN ('pending_approval', 'approved', 'failed') THEN 'pending_approval'
    WHEN ${latest} = 'published' THEN 'responded'
    ELSE 'drafted'
  END`;
}

/** Shared pieces of the list and count queries, built once per call. */
function reviewQueryParts(db: Db | Tx, practiceId: string) {
  const cs = currentDimensionSubquery(db, practiceId, "sentiment", "rcs");
  const cr = currentDimensionSubquery(db, practiceId, "response_risk", "rcr");

  const statusExpr = responseStatusExpr(latestResponseStatusExpr());

  /** Current rating: the latest version wins when it recorded one. */
  const ratingExpr = sql<
    string | null
  >`CASE WHEN ${signals.currentVersionId} IS NOT NULL AND ${signalVersions.rating} IS NOT NULL THEN ${signalVersions.rating} ELSE ${signals.originalRating} END`;

  /**
   * SQL mirror of `isNegativeReview` (`@wellregarded/core`): rating ≤ 2 or
   * current sentiment `negative` — #80's approval gate shares the core
   * predicate.
   */
  const negativeExpr = sql<boolean>`(${ratingExpr} <= 2 OR ${cs.value} = '"negative"'::jsonb)`;

  /** The five ordering tiers — see the module doc. */
  const tierExpr = sql<number>`CASE
    WHEN ${statusExpr} = 'needs_response' AND ${negativeExpr} THEN 1
    WHEN ${statusExpr} = 'needs_response' AND ${cs.value} = '"mixed"'::jsonb THEN 2
    WHEN ${statusExpr} = 'needs_response' THEN 3
    WHEN ${statusExpr} IN ('drafted', 'pending_approval') THEN 4
    ELSE 5
  END`;

  /**
   * One ascending sort key across mixed per-tier directions: tiers 1–2
   * order oldest-first (positive epoch), tiers 3–5 newest-first (negated
   * epoch). float8 on both sides so the value a cursor carries is exactly
   * the value the comparison recomputes.
   */
  const sortKeyExpr = sql<number>`CASE
    WHEN ${tierExpr} <= 2 THEN extract(epoch FROM ${signals.occurredAt})::float8
    ELSE -extract(epoch FROM ${signals.occurredAt})::float8
  END`;

  return { cs, cr, statusExpr, ratingExpr, tierExpr, sortKeyExpr };
}

/** The review predicate + every filter, ANDed. `status` is optional so the
 * count query can reuse the rest. */
function reviewConditions(
  practiceId: string,
  filters: ReviewInboxFilters,
  parts: ReturnType<typeof reviewQueryParts>,
  options: { includeStatus: boolean },
): SQL[] {
  const conditions: SQL[] = [
    eq(signals.practiceId, practiceId),
    // The review predicate: public + review-semantics source kind.
    eq(signals.visibility, "public"),
    inArray(signals.sourceKind, [...REVIEW_SOURCE_KINDS]),
  ];
  if (filters.source) {
    conditions.push(eq(signals.sourceKind, filters.source));
  }
  if (filters.locationId) {
    conditions.push(eq(signals.locationId, filters.locationId));
  }
  if (filters.ratings && filters.ratings.length > 0) {
    conditions.push(
      sql`floor(${parts.ratingExpr})::int IN (${sql.join(
        filters.ratings.map((rating) => sql`${rating}`),
        sql`, `,
      )})`,
    );
  }
  if (filters.sentiment) {
    conditions.push(
      filters.sentiment === "unclassified"
        ? sql`${parts.cs.signalId} IS NULL`
        : sql`${parts.cs.value} = ${JSON.stringify(filters.sentiment)}::jsonb`,
    );
  }
  if (options.includeStatus && filters.status) {
    conditions.push(sql`${parts.statusExpr} = ${filters.status}`);
  }
  return conditions;
}

/**
 * The review inbox list (issue #76). Filters AND together; ordering and
 * pagination are described in the module doc.
 */
export async function listReviewInbox(
  db: Db | Tx,
  params: ListReviewInboxParams,
): Promise<ReviewInboxPage> {
  const { practiceId } = params;
  const filters = params.filters ?? {};
  const sort = params.sort ?? "attention";
  const limit = params.limit ?? REVIEWS_PAGE_SIZE;

  const parts = reviewQueryParts(db, practiceId);
  const { cs, cr, statusExpr, ratingExpr, tierExpr, sortKeyExpr } = parts;

  const conditions = reviewConditions(practiceId, filters, parts, {
    includeStatus: true,
  });

  const cursor = decodeReviewsCursor(params.cursor, sort);
  if (cursor?.m === "a") {
    // Row-value comparison matches the all-ASC attention ORDER BY.
    conditions.push(
      sql`(${tierExpr}, ${sortKeyExpr}, ${signals.id}) > (${cursor.x}::int, ${cursor.k}::float8, ${cursor.i}::uuid)`,
    );
  } else if (cursor?.m === "n") {
    conditions.push(
      sql`(${signals.occurredAt}, ${signals.id}) < (${cursor.t}::timestamptz, ${cursor.i}::uuid)`,
    );
  }

  const rows = await db
    .select({
      id: signals.id,
      sourceKind: signals.sourceKind,
      availability: signals.availability,
      occurredAt: signals.occurredAt,
      originalText: signals.originalText,
      currentVersionId: signals.currentVersionId,
      versionContent: signalVersions.content,
      rating: ratingExpr,
      locationName: locations.name,
      providerName: providers.displayName,
      sentimentValue: cs.value,
      sentimentBasis: cs.basis,
      sentimentConfidence: cs.confidence,
      riskValue: cr.value,
      riskBasis: cr.basis,
      riskConfidence: cr.confidence,
      status: statusExpr,
      tier: tierExpr,
      sortKey: sortKeyExpr,
    })
    .from(signals)
    .leftJoin(signalVersions, eq(signalVersions.id, signals.currentVersionId))
    .leftJoin(locations, eq(locations.id, signals.locationId))
    .leftJoin(providers, eq(providers.id, signals.providerId))
    .leftJoin(cs, eq(cs.signalId, signals.id))
    .leftJoin(cr, eq(cr.signalId, signals.id))
    .where(and(...conditions))
    .orderBy(
      ...(sort === "attention"
        ? [
            sql`${tierExpr} ASC`,
            sql`${sortKeyExpr} ASC`,
            sql`${signals.id} ASC`,
          ]
        : [desc(signals.occurredAt), desc(signals.id)]),
    )
    .limit(limit + 1);

  const pageRows = rows.slice(0, limit);
  const items: ReviewInboxItem[] = pageRows.map((row) => ({
    id: row.id,
    // The predicate restricts source kinds; the cast records that.
    sourceKind: row.sourceKind as ReviewSourceKind,
    availability: row.availability,
    occurredAt: row.occurredAt,
    text: row.currentVersionId !== null ? row.versionContent : row.originalText,
    rating: row.rating,
    locationName: row.locationName,
    providerName: row.providerName,
    sentiment: judgment(
      row.sentimentValue,
      row.sentimentBasis,
      row.sentimentConfidence,
    ),
    responseRisk: judgment(row.riskValue, row.riskBasis, row.riskConfidence),
    status: row.status,
  }));

  const last = pageRows[pageRows.length - 1];
  const hasMore = rows.length > limit && last !== undefined;
  return {
    items,
    nextCursor: !hasMore
      ? null
      : encodeReviewsCursor(
          sort === "attention"
            ? {
                m: "a",
                x: Number(last.tier),
                k: Number(last.sortKey),
                i: last.id,
              }
            : { m: "n", t: last.occurredAt.toISOString(), i: last.id },
        ),
  };
}

function judgment(
  value: unknown,
  basis: SignalListJudgment["basis"] | null,
  confidence: number | null,
): SignalListJudgment | null {
  if (value === null || basis === null || confidence === null) return null;
  return { value: String(value), basis, confidence };
}

/** Per-status counts for the counted tabs (#76 / the mockup). */
export interface ReviewInboxCounts {
  total: number;
  needs_response: number;
  drafted: number;
  pending_approval: number;
  responded: number;
}

/**
 * Counts per response status for the tab row, respecting every filter
 * EXCEPT `status` (the tabs ARE the status filter — each shows what
 * choosing it would yield). One GROUP BY query.
 */
export async function countReviewInboxStatuses(
  db: Db | Tx,
  params: { practiceId: string; filters?: ReviewInboxFilters },
): Promise<ReviewInboxCounts> {
  const filters = params.filters ?? {};
  const parts = reviewQueryParts(db, params.practiceId);
  const conditions = reviewConditions(params.practiceId, filters, parts, {
    includeStatus: false,
  });

  const rows = await db
    .select({
      status: parts.statusExpr,
      count: sql<number>`count(*)::int`,
    })
    .from(signals)
    .leftJoin(signalVersions, eq(signalVersions.id, signals.currentVersionId))
    .leftJoin(parts.cs, eq(parts.cs.signalId, signals.id))
    .where(and(...conditions))
    .groupBy(parts.statusExpr);

  const counts: ReviewInboxCounts = {
    total: 0,
    needs_response: 0,
    drafted: 0,
    pending_approval: 0,
    responded: 0,
  };
  for (const row of rows) {
    counts[row.status] = row.count;
    counts.total += row.count;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Detail view (issue #77)
// ---------------------------------------------------------------------------

/**
 * One entry of the response thread, as the detail view renders it. This is
 * the UI-side contract for the seam: #80's `responses` table populates it
 * (newest first), #79's composer appends to it. Beyond the display fields,
 * it carries what the workflow surface (#80/#82) needs to render actions:
 * the author id (self-approval rules), the reject comment, and the stored
 * publish failure.
 */
export interface ReviewResponseThreadEntry {
  id: string;
  /** #80's `responses.status` vocabulary (draft … published/failed). */
  status: string;
  body: string;
  authorId: string | null;
  authorName: string | null;
  createdAt: Date;
  publishedAt: Date | null;
  /** Where the published reply lives at the source, when known. */
  publishedUrl: string | null;
  /** Latest "changes requested" comment, for rejected drafts. */
  rejectionComment: string | null;
  /** Stored publish failure (#82's error_detail contract). */
  errorDetail: ResponseErrorDetail | null;
  /** GBP reply moderation state, for published rows (#117 spike). */
  moderationState: ResponseModerationState | null;
}

export interface ReviewDetail {
  /** The full signal row — includes the provider/location hints (#104). */
  signal: Signal;
  /** Current content — latest version wins over the immutable original. */
  currentText: string | null;
  currentRating: string | null;
  edited: boolean;
  locationName: string | null;
  providerName: string | null;
  /** Current derivation per dimension; `undefined` = not yet classified. */
  currentDerivations: CurrentDerivations;
  /** Resolution documented on `reviewStatusFromResponseState`. */
  status: ReviewResponseStatus;
  /**
   * All responses for this signal, newest first. TODO(#80): read from the
   * `responses` table once it exists; always empty until then.
   */
  responses: ReviewResponseThreadEntry[];
  // TODO(Epic #15): related `recovery_items` card — the table does not
  // exist yet (see the factory TODO in test/factories.ts); the detail
  // view omits the section entirely until it lands.
}

/**
 * Assemble the review detail (issue #77). Returns `undefined` for a
 * missing signal, a cross-practice id, a private signal, or a non-review
 * source kind — the loader 404s all four identically; existence is never
 * disclosed.
 */
export async function getReviewDetail(
  db: Db,
  params: { practiceId: string; signalId: string },
): Promise<ReviewDetail | undefined> {
  const { practiceId, signalId } = params;

  const headRows = await db
    .select({
      signal: signals,
      versionContent: signalVersions.content,
      versionRating: signalVersions.rating,
      locationName: locations.name,
      providerName: providers.displayName,
    })
    .from(signals)
    .leftJoin(signalVersions, eq(signalVersions.id, signals.currentVersionId))
    .leftJoin(locations, eq(locations.id, signals.locationId))
    .leftJoin(providers, eq(providers.id, signals.providerId))
    .where(
      and(
        eq(signals.id, signalId),
        eq(signals.practiceId, practiceId),
        eq(signals.visibility, "public"),
        inArray(signals.sourceKind, [...REVIEW_SOURCE_KINDS]),
      ),
    )
    .limit(1);
  const head = headRows[0];
  if (!head) return undefined;
  const { signal } = head;

  // Parallel assembly: derivations and the newest-first response thread
  // (feeding both the thread and the status resolution below).
  const [currentDerivations, responseRows] = await Promise.all([
    getCurrentDerivations(db, signalId),
    listResponsesForSignal(db, practiceId, signalId),
  ]);
  const responses: ReviewResponseThreadEntry[] = responseRows.map((row) => ({
    id: row.id,
    status: row.status,
    body: row.body,
    authorId: row.authorId,
    authorName: row.authorName,
    createdAt: row.createdAt,
    publishedAt: row.publishedAt,
    // The reply's canonical home is the review it hangs off (the GBP PUT
    // returns no per-reply URL — see #127's contract).
    publishedUrl: row.publishedAt !== null ? signal.sourceUrl : null,
    rejectionComment: row.rejectionComment,
    errorDetail: row.errorDetail,
    moderationState: row.moderationState,
  }));

  const hasVersion = signal.currentVersionId !== null;
  return {
    signal,
    currentText: hasVersion ? head.versionContent : signal.originalText,
    currentRating:
      hasVersion && head.versionRating !== null
        ? head.versionRating
        : signal.originalRating,
    edited: hasVersion,
    locationName: head.locationName,
    providerName: head.providerName,
    currentDerivations,
    status: reviewStatusFromResponseState(responses[0]?.status ?? null),
    responses,
  };
}
