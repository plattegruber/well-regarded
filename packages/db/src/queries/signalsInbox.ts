/**
 * Signals inbox reads (issues #88/#90, Epic #11): the unified list
 * (`listSignals`) and the detail assembly (`getSignalDetail`).
 *
 * Two rules are enforced HERE, in the query/serialization layer — not in
 * the UI:
 *
 * - **Patient identity**: rows never carry a patient's name unless the
 *   viewer holds `view_patient_identity` (Epic #4 matrix). Without it the
 *   `pii.patients` join is never even added to the query; callers receive
 *   `{ redacted: true }`. On the detail view, an identity that IS included
 *   writes a `patient.viewed` row to `audit_log` (Epic #4's
 *   patient-data-access rule).
 * - **Private feedback**: without `view_private_feedback` the list is
 *   forced to `visibility = 'public'` and a private signal's detail reads
 *   as absent (`undefined` → the loader's 404) — never a hint that the
 *   signal exists.
 *
 * Full-text search runs over the generated `signals.tsv` column (migration
 * 0016) with `websearch_to_tsquery('english', ...)`, practice-scoped first;
 * results order by `ts_rank` desc, then recency. Pagination is keyset
 * (occurred_at, id — plus rank when searching), 25/page.
 */

import {
  type Actor,
  DERIVATION_DIMENSIONS,
  type DerivationBasis,
  type DerivationDimension,
  type SentimentFilter,
  type SignalAvailability,
  type SignalVisibility,
  type SourceKind,
  type UrgencyFilter,
} from "@wellregarded/core";
import { and, asc, desc, eq, type SQL, sql } from "drizzle-orm";

import { audit, type Tx } from "../audit.js";
import type { Db } from "../client.js";
import { consents } from "../schema/consents.js";
import { signalVersions, suspectedDuplicates } from "../schema/dedupe.js";
import { derivations } from "../schema/derivations.js";
import { patients } from "../schema/pii.js";
import { proofExcerpts } from "../schema/proofExcerpts.js";
import { signals } from "../schema/signals.js";
import { locations, providers } from "../schema/tenancy.js";
import type { Consent } from "./consents.js";
import type { SignalVersion, SuspectedDuplicate } from "./dedupe.js";
import type { Derivation } from "./derivations.js";
import { getImportRunSummary, type ImportRunSummary } from "./importRuns.js";
import type { Signal } from "./signals.js";

/** The two Epic #4 gates the inbox queries enforce at the data layer. */
export interface SignalViewerPermissions {
  viewPrivateFeedback: boolean;
  viewPatientIdentity: boolean;
}

/**
 * The inbox's URL-param filters (issue #88), all combined with AND.
 *
 * TODO(Epic #15): `has_recovery` — the issue lists it, but the
 * `recovery_items` table does not exist yet (see the factory TODO in
 * `test/factories.ts`); add the filter when the table lands.
 */
export interface SignalListFilters {
  sourceKind?: SourceKind;
  visibility?: SignalVisibility;
  /** Current-derivation sentiment; `unclassified` = no sentiment row. */
  sentiment?: SentimentFilter;
  /** Current-derivation urgency; `unclassified` = no urgency row. */
  urgency?: UrgencyFilter;
  locationId?: string;
  providerId?: string;
  /** Only signals with a pending suspected-duplicate link (Epic #6). */
  suspectedDuplicate?: boolean;
  /**
   * Full-text query, parsed with `websearch_to_tsquery('english', ...)` —
   * quoted phrases and `-exclusions` work.
   */
  q?: string;
}

/** A current derivation as the list renders it: value + basis, honestly. */
export interface SignalListJudgment {
  value: string;
  basis: DerivationBasis;
  confidence: number;
}

export interface SignalListPatient {
  /**
   * `null` with `redacted: true` when the viewer lacks
   * `view_patient_identity`; `null` with `redacted: false` for a patient
   * row that simply has no recorded name.
   */
  displayName: string | null;
  redacted: boolean;
}

export interface SignalListItem {
  id: string;
  sourceKind: SourceKind;
  visibility: SignalVisibility;
  availability: SignalAvailability;
  occurredAt: Date;
  /** Current text — the latest recorded version wins over the original. */
  text: string | null;
  /** Current rating on the source's own scale (numeric string, e.g. "4.0"). */
  rating: string | null;
  /** True when an edited re-import recorded a version (issue #106). */
  edited: boolean;
  locationName: string | null;
  providerName: string | null;
  /** Present only when the signal links a patient. */
  patient: SignalListPatient | null;
  sentiment: SignalListJudgment | null;
  urgency: SignalListJudgment | null;
  /** A pending suspected-duplicate link exists (either side). */
  suspectedDuplicate: boolean;
  /**
   * The winning (highest-version) consent row, when any consent is
   * recorded — interpret with `describeConsentState` from
   * `@wellregarded/core` (one implementation of "is this publishable").
   */
  consent: Consent | null;
}

export interface ListSignalsParams {
  practiceId: string;
  viewer: SignalViewerPermissions;
  filters?: SignalListFilters;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string | null;
  /** Page size; defaults to 25. */
  limit?: number;
}

export interface SignalListPage {
  items: SignalListItem[];
  /** Cursor for the next (older / lower-ranked) page; null on the last. */
  nextCursor: string | null;
}

export const SIGNALS_PAGE_SIZE = 25;

/**
 * Keyset cursor payload: rank (search mode only) + occurred_at + id,
 * matching the ORDER BY exactly. Opaque base64url over JSON.
 */
interface SignalsCursor {
  r?: number;
  t: string;
  i: string;
}

function encodeSignalsCursor(payload: SignalsCursor): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `null` for anything malformed — a bad cursor reads as page one. */
export function decodeSignalsCursor(
  cursor: string | null | undefined,
): { rank: number | null; occurredAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as SignalsCursor;
    if (typeof parsed.t !== "string" || typeof parsed.i !== "string") {
      return null;
    }
    // Both values are cast in SQL (::timestamptz / ::uuid) — validate here
    // so a tampered cursor reads as page one, not a database error.
    if (Number.isNaN(Date.parse(parsed.t)) || !UUID_RE.test(parsed.i)) {
      return null;
    }
    return {
      rank: typeof parsed.r === "number" ? parsed.r : null,
      occurredAt: parsed.t,
      id: parsed.i,
    };
  } catch {
    return null;
  }
}

/** DISTINCT ON current-derivation subquery for one dimension (see
 * `../queries/derivations.js` for the manual-outranks-inferred rule the
 * ordering encodes). Exported for the review inbox (`reviewsInbox.ts`),
 * which resolves current sentiment/response-risk the same way. */
export function currentDimensionSubquery(
  db: Db | Tx,
  practiceId: string,
  dimension: DerivationDimension,
  alias: string,
) {
  return db
    .selectDistinctOn([derivations.signalId], {
      signalId: derivations.signalId,
      value: derivations.value,
      basis: derivations.basis,
      confidence: derivations.confidence,
    })
    .from(derivations)
    .where(
      and(
        eq(derivations.practiceId, practiceId),
        eq(derivations.dimension, dimension),
      ),
    )
    .orderBy(
      derivations.signalId,
      sql`(${derivations.basis} = 'manual') DESC`,
      desc(derivations.createdAt),
    )
    .as(alias);
}

/**
 * The unified signals inbox query (issue #88): every filter ANDs with the
 * rest and with the FTS search; ordering is `ts_rank` desc → recency when
 * searching, recency alone otherwise; pagination is keyset. Permission
 * enforcement is described in the module doc.
 */
export async function listSignals(
  db: Db | Tx,
  params: ListSignalsParams,
): Promise<SignalListPage> {
  const { practiceId, viewer } = params;
  const filters = params.filters ?? {};
  const limit = params.limit ?? SIGNALS_PAGE_SIZE;
  const q = filters.q?.trim() ?? "";
  const searching = q.length > 0;

  const cs = currentDimensionSubquery(db, practiceId, "sentiment", "cs");
  const cu = currentDimensionSubquery(db, practiceId, "urgency", "cu");
  // Winning consent per signal: highest version is the current state.
  const cc = db
    .selectDistinctOn([consents.signalId], {
      signalId: consents.signalId,
      consentRow: sql<Consent>`row_to_json(${consents})`.as("consent_row"),
    })
    .from(consents)
    .where(eq(consents.practiceId, practiceId))
    .orderBy(consents.signalId, desc(consents.consentVersion))
    .as("cc");

  const rankExpr = searching
    ? sql<number>`ts_rank(${signals.tsv}, websearch_to_tsquery('english', ${q}))`
    : sql<number | null>`NULL::real`;
  const pendingDuplicateExpr = sql<boolean>`EXISTS (
    SELECT 1 FROM ${suspectedDuplicates} sd
    WHERE sd.status = 'pending_review'
      AND (sd.signal_id_a = ${signals.id} OR sd.signal_id_b = ${signals.id})
  )`;

  const conditions: SQL[] = [eq(signals.practiceId, practiceId)];
  // The private-feedback gate composes with (and can contradict) the
  // visibility filter — both apply, least privilege wins.
  if (!viewer.viewPrivateFeedback) {
    conditions.push(eq(signals.visibility, "public"));
  }
  if (filters.visibility) {
    conditions.push(eq(signals.visibility, filters.visibility));
  }
  if (filters.sourceKind) {
    conditions.push(eq(signals.sourceKind, filters.sourceKind));
  }
  if (filters.locationId) {
    conditions.push(eq(signals.locationId, filters.locationId));
  }
  if (filters.providerId) {
    conditions.push(eq(signals.providerId, filters.providerId));
  }
  if (filters.sentiment) {
    conditions.push(
      filters.sentiment === "unclassified"
        ? sql`${cs.signalId} IS NULL`
        : sql`${cs.value} = ${JSON.stringify(filters.sentiment)}::jsonb`,
    );
  }
  if (filters.urgency) {
    conditions.push(
      filters.urgency === "unclassified"
        ? sql`${cu.signalId} IS NULL`
        : sql`${cu.value} = ${JSON.stringify(filters.urgency)}::jsonb`,
    );
  }
  if (filters.suspectedDuplicate) {
    conditions.push(pendingDuplicateExpr);
  }
  if (searching) {
    conditions.push(
      sql`${signals.tsv} @@ websearch_to_tsquery('english', ${q})`,
    );
  }

  const cursor = decodeSignalsCursor(params.cursor);
  if (cursor) {
    // Row-value comparison matches the all-DESC ORDER BY lexicographically.
    conditions.push(
      searching && cursor.rank !== null
        ? sql`(${rankExpr}, ${signals.occurredAt}, ${signals.id}) < (${cursor.rank}::real, ${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)`
        : sql`(${signals.occurredAt}, ${signals.id}) < (${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)`,
    );
  }

  let query = db
    .select({
      id: signals.id,
      sourceKind: signals.sourceKind,
      visibility: signals.visibility,
      availability: signals.availability,
      occurredAt: signals.occurredAt,
      originalText: signals.originalText,
      originalRating: signals.originalRating,
      currentVersionId: signals.currentVersionId,
      versionContent: signalVersions.content,
      versionRating: signalVersions.rating,
      patientId: signals.patientId,
      // The identity gate: without the permission this is a constant NULL
      // and pii.patients is never joined — the name cannot leak.
      patientDisplayName: viewer.viewPatientIdentity
        ? patients.displayName
        : sql<string | null>`NULL`,
      locationName: locations.name,
      providerName: providers.displayName,
      sentimentValue: cs.value,
      sentimentBasis: cs.basis,
      sentimentConfidence: cs.confidence,
      urgencyValue: cu.value,
      urgencyBasis: cu.basis,
      urgencyConfidence: cu.confidence,
      consentRow: cc.consentRow,
      suspectedDuplicate: pendingDuplicateExpr,
      rank: rankExpr,
    })
    .from(signals)
    .leftJoin(signalVersions, eq(signalVersions.id, signals.currentVersionId))
    .leftJoin(locations, eq(locations.id, signals.locationId))
    .leftJoin(providers, eq(providers.id, signals.providerId))
    .leftJoin(cs, eq(cs.signalId, signals.id))
    .leftJoin(cu, eq(cu.signalId, signals.id))
    .leftJoin(cc, eq(cc.signalId, signals.id))
    .$dynamic();
  if (viewer.viewPatientIdentity) {
    query = query.leftJoin(patients, eq(patients.id, signals.patientId));
  }

  const rows = await query
    .where(and(...conditions))
    .orderBy(
      ...(searching
        ? [desc(rankExpr), desc(signals.occurredAt), desc(signals.id)]
        : [desc(signals.occurredAt), desc(signals.id)]),
    )
    .limit(limit + 1);

  const pageRows = rows.slice(0, limit);
  const items: SignalListItem[] = pageRows.map((row) => ({
    id: row.id,
    sourceKind: row.sourceKind,
    visibility: row.visibility,
    availability: row.availability,
    occurredAt: row.occurredAt,
    text: row.currentVersionId !== null ? row.versionContent : row.originalText,
    rating:
      row.currentVersionId !== null && row.versionRating !== null
        ? row.versionRating
        : row.originalRating,
    edited: row.currentVersionId !== null,
    locationName: row.locationName,
    providerName: row.providerName,
    patient:
      row.patientId === null
        ? null
        : {
            displayName: row.patientDisplayName,
            redacted: !viewer.viewPatientIdentity,
          },
    sentiment: judgment(
      row.sentimentValue,
      row.sentimentBasis,
      row.sentimentConfidence,
    ),
    urgency: judgment(
      row.urgencyValue,
      row.urgencyBasis,
      row.urgencyConfidence,
    ),
    suspectedDuplicate: row.suspectedDuplicate,
    consent: row.consentRow === null ? null : reviveConsent(row.consentRow),
  }));

  const last = pageRows[pageRows.length - 1];
  const lastRow = rows.length > limit && last !== undefined ? last : null;
  return {
    items,
    nextCursor:
      lastRow === null
        ? null
        : encodeSignalsCursor({
            ...(searching && lastRow.rank !== null ? { r: lastRow.rank } : {}),
            t: lastRow.occurredAt.toISOString(),
            i: lastRow.id,
          }),
  };
}

function judgment(
  value: unknown,
  basis: DerivationBasis | null,
  confidence: number | null,
): SignalListJudgment | null {
  if (value === null || basis === null || confidence === null) return null;
  return { value: String(value), basis, confidence };
}

/**
 * `row_to_json` returns snake_case keys with string timestamps; revive
 * into the camelCase `Consent` row shape `describeConsentState` consumes.
 */
function reviveConsent(raw: unknown): Consent {
  const row = raw as Record<string, unknown>;
  const date = (value: unknown): Date | null =>
    value == null ? null : new Date(value as string);
  return {
    id: row.id as string,
    practiceId: row.practice_id as string,
    signalId: row.signal_id as string,
    patientId: (row.patient_id as string | null) ?? null,
    channels: parsePgTextArray(row.channels) as Consent["channels"],
    attribution: row.attribution as Consent["attribution"],
    allowMinorEdits: row.allow_minor_edits as boolean,
    grantedAt: date(row.granted_at) as Date,
    source: row.source as Consent["source"],
    consentVersion: row.consent_version as number,
    revokedAt: date(row.revoked_at),
    expiresAt: date(row.expires_at),
    createdAt: date(row.created_at) as Date,
  };
}

/**
 * `row_to_json` renders a Postgres enum[] as a JSON array already; but a
 * driver that leaves it as the `{a,b}` literal still parses. Both shapes
 * normalize to a string array here.
 */
function parsePgTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string" && value.startsWith("{")) {
    const inner = value.slice(1, -1);
    return inner.length === 0 ? [] : inner.split(",");
  }
  return [];
}

/** The inbox filter dropdowns' option lists (locations, providers). */
export interface SignalFilterOptions {
  locations: Array<{ id: string; name: string }>;
  providers: Array<{ id: string; name: string }>;
}

export async function listSignalFilterOptions(
  db: Db | Tx,
  practiceId: string,
): Promise<SignalFilterOptions> {
  const [locationRows, providerRows] = await Promise.all([
    db
      .select({ id: locations.id, name: locations.name })
      .from(locations)
      .where(eq(locations.practiceId, practiceId))
      .orderBy(asc(locations.name)),
    db
      .select({ id: providers.id, name: providers.displayName })
      .from(providers)
      .where(eq(providers.practiceId, practiceId))
      .orderBy(asc(providers.displayName)),
  ]);
  return { locations: locationRows, providers: providerRows };
}

// ---------------------------------------------------------------------------
// Detail view (issue #90)
// ---------------------------------------------------------------------------

export interface SignalDetailDuplicate {
  /** The `suspected_duplicates` row — resolve actions target its id. */
  link: SuspectedDuplicate;
  /** Compact preview of the counterpart signal for the side-by-side. */
  other: {
    id: string;
    sourceKind: SourceKind;
    visibility: SignalVisibility;
    occurredAt: Date;
    text: string | null;
    rating: string | null;
  };
}

export interface SignalDetailExcerpt {
  id: string;
  excerptText: string;
  topicHint: string | null;
  topics: string[] | null;
  startOffset: number | null;
}

export interface SignalDetail {
  signal: Signal;
  /** Current content — latest version wins over the immutable original. */
  currentText: string | null;
  currentRating: string | null;
  locationName: string | null;
  providerName: string | null;
  /** Present only when the signal links a patient; see the list shape. */
  patient: SignalListPatient | null;
  /** Current derivation per dimension; `undefined` = not yet classified. */
  currentDerivations: Record<DerivationDimension, Derivation | undefined>;
  /** Every consent row — interpret with `describeConsentState`. */
  consents: Consent[];
  excerpts: SignalDetailExcerpt[];
  /** Append-only edit history (issue #106), newest first. */
  versions: SignalVersion[];
  /** Pending suspected-duplicate links (either side), with previews. */
  duplicates: SignalDetailDuplicate[];
  importRun: ImportRunSummary | undefined;
}

export interface GetSignalDetailParams {
  practiceId: string;
  signalId: string;
  viewer: SignalViewerPermissions;
  /**
   * Who is looking — required because including a patient's identity
   * writes a `patient.viewed` audit row (Epic #4's rule).
   */
  actor: Actor;
}

/**
 * Assemble the signal detail (issue #90) in parallel queries — no
 * waterfall. Returns `undefined` for a missing signal, a cross-practice id,
 * or a private signal the viewer may not see (loaders 404 all three —
 * existence is not disclosed).
 */
export async function getSignalDetail(
  db: Db,
  params: GetSignalDetailParams,
): Promise<SignalDetail | undefined> {
  const { practiceId, signalId, viewer, actor } = params;

  const signalRows = await db
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
    .where(and(eq(signals.id, signalId), eq(signals.practiceId, practiceId)))
    .limit(1);
  const head = signalRows[0];
  if (!head) return undefined;
  const { signal } = head;
  if (signal.visibility === "private" && !viewer.viewPrivateFeedback) {
    return undefined;
  }

  const [
    derivationRows,
    consentRows,
    excerptRows,
    versionRows,
    duplicateRows,
    importRun,
    patient,
  ] = await Promise.all([
    db
      .selectDistinctOn([derivations.signalId, derivations.dimension])
      .from(derivations)
      .where(eq(derivations.signalId, signalId))
      .orderBy(
        derivations.signalId,
        derivations.dimension,
        sql`(${derivations.basis} = 'manual') DESC`,
        desc(derivations.createdAt),
      ),
    db
      .select()
      .from(consents)
      .where(eq(consents.signalId, signalId))
      .orderBy(desc(consents.consentVersion)),
    db
      .select({
        id: proofExcerpts.id,
        excerptText: proofExcerpts.excerptText,
        topicHint: proofExcerpts.topicHint,
        topics: proofExcerpts.topics,
        startOffset: proofExcerpts.startOffset,
      })
      .from(proofExcerpts)
      .where(eq(proofExcerpts.signalId, signalId))
      .orderBy(
        sql`${proofExcerpts.startOffset} ASC NULLS LAST`,
        proofExcerpts.createdAt,
      ),
    db
      .select()
      .from(signalVersions)
      .where(eq(signalVersions.signalId, signalId))
      .orderBy(desc(signalVersions.createdAt)),
    listPendingDuplicatesWithPreviews(db, practiceId, signalId),
    signal.importRunId
      ? getImportRunSummary(db, practiceId, signal.importRunId)
      : Promise.resolve(undefined),
    resolvePatientForViewer(db, { practiceId, signal, viewer, actor }),
  ]);

  const currentDerivations = Object.fromEntries(
    DERIVATION_DIMENSIONS.map((dimension) => [dimension, undefined]),
  ) as Record<DerivationDimension, Derivation | undefined>;
  for (const row of derivationRows) {
    currentDerivations[row.dimension] = row;
  }

  const hasVersion = signal.currentVersionId !== null;
  return {
    signal,
    currentText: hasVersion ? head.versionContent : signal.originalText,
    currentRating:
      hasVersion && head.versionRating !== null
        ? head.versionRating
        : signal.originalRating,
    locationName: head.locationName,
    providerName: head.providerName,
    patient,
    currentDerivations,
    consents: consentRows,
    excerpts: excerptRows,
    versions: versionRows,
    duplicates: duplicateRows,
    importRun,
  };
}

/**
 * The identity seam: reads `pii.patients` ONLY when the viewer holds
 * `view_patient_identity`, and writes the `patient.viewed` audit row in the
 * same breath — displaying identity and logging the access are one path.
 */
async function resolvePatientForViewer(
  db: Db,
  input: {
    practiceId: string;
    signal: Signal;
    viewer: SignalViewerPermissions;
    actor: Actor;
  },
): Promise<SignalListPatient | null> {
  const { practiceId, signal, viewer, actor } = input;
  if (signal.patientId === null) return null;
  if (!viewer.viewPatientIdentity) {
    return { displayName: null, redacted: true };
  }
  const [row] = await db
    .select({ displayName: patients.displayName })
    .from(patients)
    .where(eq(patients.id, signal.patientId))
    .limit(1);
  await audit(db, {
    practiceId,
    actor,
    action: "patient.viewed",
    entityType: "patients",
    entityId: signal.patientId,
    // References only, never raw PII (the audit contract).
    payload: { signalId: signal.id, surface: "signal_detail" },
  });
  return { displayName: row?.displayName ?? null, redacted: false };
}

/** Pending links for one signal (either side) + counterpart previews. */
async function listPendingDuplicatesWithPreviews(
  db: Db,
  practiceId: string,
  signalId: string,
): Promise<SignalDetailDuplicate[]> {
  const links = await db
    .select({
      link: suspectedDuplicates,
      other: {
        id: signals.id,
        sourceKind: signals.sourceKind,
        visibility: signals.visibility,
        occurredAt: signals.occurredAt,
        originalText: signals.originalText,
        originalRating: signals.originalRating,
        currentVersionId: signals.currentVersionId,
      },
      versionContent: signalVersions.content,
      versionRating: signalVersions.rating,
    })
    .from(suspectedDuplicates)
    .innerJoin(
      signals,
      sql`${signals.id} = CASE WHEN ${suspectedDuplicates.signalIdA} = ${signalId}::uuid THEN ${suspectedDuplicates.signalIdB} ELSE ${suspectedDuplicates.signalIdA} END`,
    )
    .leftJoin(signalVersions, eq(signalVersions.id, signals.currentVersionId))
    .where(
      and(
        eq(suspectedDuplicates.practiceId, practiceId),
        eq(suspectedDuplicates.status, "pending_review"),
        sql`(${suspectedDuplicates.signalIdA} = ${signalId}::uuid OR ${suspectedDuplicates.signalIdB} = ${signalId}::uuid)`,
      ),
    )
    .orderBy(desc(suspectedDuplicates.createdAt));

  return links.map((row) => {
    const hasVersion = row.other.currentVersionId !== null;
    return {
      link: row.link,
      other: {
        id: row.other.id,
        sourceKind: row.other.sourceKind,
        visibility: row.other.visibility,
        occurredAt: row.other.occurredAt,
        text: hasVersion ? row.versionContent : row.other.originalText,
        rating:
          hasVersion && row.versionRating !== null
            ? row.versionRating
            : row.other.originalRating,
      },
    };
  });
}
