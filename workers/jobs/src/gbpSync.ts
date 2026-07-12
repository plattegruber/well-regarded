/**
 * GBP incremental review sync — the engine one `SyncLock` DO run executes
 * for one connection (issue #123, Epic #7).
 *
 * Kept free of `cloudflare:workers` imports and typed structurally
 * (`GbpSyncStore` / `GbpSyncDeps`) following the pipeline stages' pattern:
 * unit tests fake the store and drive the fake GBP server in-process;
 * integration tests wire the real drizzle store against Postgres
 * (./gbpSyncStore.ts); the DO (./sync-lock.ts) wires everything to real
 * bindings via ./gbpSyncRuntime.ts.
 *
 * THE CURSOR (issue #123 requirement 3)
 * -------------------------------------
 * Reviews are fetched `orderBy=updateTime desc` (under the mapping's v4
 * account-scoped parent) and walked newest-first until a page ends in
 * already-seen territory. The cursor is the max `updateTime` seen per
 * location, stored in `source_connections.metadata.syncCursors` — next to
 * the #121 mapping it belongs to, written via the shared per-key metadata
 * patch (`patchSourceConnectionMetadata`), and keyed by the mapping's
 * STABLE identity (the v1 `locations/{id}` name, #121's key — a listing
 * moving between accounts changes its v4 name, never its identity). It
 * advances ONLY after the location's pages are durably in R2 and enqueued
 * (crash-safe: re-polling an un-advanced cursor just re-sends artifacts
 * the pipeline dedupes).
 * `updateTime` (not `createTime`) drives it deliberately: an edited review
 * re-enters the pipeline, where dedupe's exact path (#106) records it as a
 * signal *version* keyed on `sourceMetadata.sourceUpdatedAt` — re-sending
 * edits is the system working as designed, not a bug.
 *
 * GRACEFUL DEGRADATION (requirements 5–6)
 * ---------------------------------------
 * - 429/5xx: exponential backoff with jitter per request (1 s/4 s/16 s, 3
 *   attempts, `Retry-After` honored); on exhaustion the REMAINDER of the
 *   sync aborts — run finalized `completed_with_errors` with the quota
 *   error recorded, cursors already advanced stay advanced, next tick
 *   resumes. Never a busy-loop against a quota error.
 * - `invalid_grant`: `NeedsReauthError` aborts the sync; the token
 *   provider's `onInvalidGrant` hook (wired to
 *   `markSourceConnectionNeedsReauth` + a system-actor audit row) already
 *   made the status durable before the error propagated here. The run
 *   finalizes `failed` with the reason. Settings card renders
 *   `needs_reauth` today; the Today-screen card (Epic #11) reads the same
 *   `source_connections.status` — no extra mechanism needed now.
 */

import type {
  GoogleConnectionCredentials,
  ImportRunTrigger,
  IngestMessage,
  Logger,
} from "@wellregarded/core";
import {
  type ActiveGoogleMapping,
  GbpApiError,
  type GbpReviewsPage,
  GOOGLE_REVIEWS_ARTIFACT_KIND,
  GoogleOAuthError,
  type GoogleReviewsArtifact,
  gbpReviewsPageSchema,
  getActiveMappings,
  NeedsReauthError,
  putRawArtifact,
  type RawArtifactBucket,
} from "@wellregarded/sources";

import {
  GBP_BACKOFF_MAX_ATTEMPTS,
  GBP_MAX_PAGES_PER_LOCATION,
  GBP_MIN_REQUEST_INTERVAL_MS,
  gbpBackoffDelayMs,
} from "./gbpPolling";

/** The connection fields the engine reads (a `source_connections` row). */
export interface GbpSyncConnectionRow {
  id: string;
  practiceId: string;
  status: string;
  /** AES-GCM ciphertext or null. NEVER-LOG(credentials). */
  encryptedCredentials: string | null;
  metadata: unknown;
}

/**
 * Durable state the sync reads/writes — the drizzle implementation lives
 * in ./gbpSyncStore.ts; unit tests fake it.
 */
export interface GbpSyncStore {
  getConnection(connectionId: string): Promise<GbpSyncConnectionRow | null>;
  createImportRun(input: {
    practiceId: string;
    trigger: ImportRunTrigger;
  }): Promise<{ id: string }>;
  /** `appendImportRunError` — sample + failed count on the run. */
  recordRunError(
    importRunId: string,
    sample: { stage: string; message: string; payloadRef: string },
  ): Promise<void>;
  /** Accumulate numeric sync stats into the run's `stats` jsonb. */
  accumulateRunStats(
    importRunId: string,
    stats: Record<string, number>,
  ): Promise<void>;
  /** Owner-decided terminal status (`finalizeImportRunWithStatus`). */
  finalizeRun(
    importRunId: string,
    status: "completed" | "completed_with_errors" | "failed",
  ): Promise<void>;
  /**
   * Record the R2 keys this run has stored so far (`rawArtifactKeys` on
   * the run row) — MUST be durable before any message referencing the run
   * is enqueued: dedupe's `conflict_reimport` path re-reads the run's keys
   * to compare an edited review's content (#106/#111 contract).
   */
  recordRunArtifactKeys(importRunId: string, keys: string[]): Promise<void>;
  /**
   * Persist the full per-location cursor map (crash-safe advance), via the
   * shared per-key metadata patch — the poller is the only cursor writer
   * and runs under the connection's SyncLock, so replacing its own
   * `syncCursors` key wholesale is race-free.
   */
  saveSyncCursors(
    connectionId: string,
    cursors: Record<string, string>,
  ): Promise<void>;
  setLastSyncAt(connectionId: string): Promise<void>;
}

/**
 * The poller's slice of `source_connections.metadata`:
 * `syncCursors[v1LocationName] = max updateTime ISO`. Tolerant of absence
 * and malformed content (first sync walks full history). Exported for the
 * store/tests; #121's keys live beside it and round-trip untouched.
 */
export function readGoogleSyncCursors(
  metadata: unknown,
): Record<string, string> {
  if (typeof metadata !== "object" || metadata === null) return {};
  const cursors = (metadata as Record<string, unknown>).syncCursors;
  if (typeof cursors !== "object" || cursors === null) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(cursors)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export interface GbpSyncDeps {
  store: GbpSyncStore;
  /** Raw-artifact bucket (`RAW_ARTIFACTS`) — store-before-enqueue (#100). */
  bucket: RawArtifactBucket;
  /** `wr-ingest` producer (`INGEST_QUEUE`). */
  ingest: { send(message: IngestMessage): Promise<void> };
  /**
   * #118 token provider (`getAccessToken`). Its `onInvalidGrant` MUST be
   * wired to the needs_reauth persistence (see ./gbpSyncRuntime.ts) —
   * this engine only reacts to the thrown `NeedsReauthError`.
   */
  getAccessToken(connection: {
    id: string;
    refreshToken: string;
  }): Promise<string>;
  /** Decrypt `encrypted_credentials` (AES-GCM via the shared keyring). */
  decryptCredentials(ciphertext: string): Promise<GoogleConnectionCredentials>;
  /** One v4 reviews.list page (`listGbpReviewsPage` with env base URL). */
  listReviewsPage(input: {
    accessToken: string;
    googleLocationName: string;
    pageToken?: string | undefined;
  }): Promise<unknown>;
  log: Logger;
  sleep(ms: number): Promise<void>;
  /** Injectable clock/RNG for deterministic tests. */
  now?: () => number;
  random?: () => number;
}

export interface GbpSyncInput {
  connectionId: string;
  trigger: ImportRunTrigger;
  /** Trace id minted at the cron/manual entry (issue #64). */
  requestId: string;
}

/** Aggregate counters for the run's `stats` jsonb + the outcome log line. */
export interface GbpSyncStats {
  locationsPolled: number;
  locationsErrored: number;
  locationsExcluded: number;
  pagesFetched: number;
  pagesStored: number;
  reviewsSeen: number;
  cursorsAdvanced: number;
}

export type GbpSyncOutcome =
  | {
      outcome: "skipped";
      reason: "not_found" | "not_active" | "no_credentials" | "no_locations";
    }
  | {
      outcome: "completed" | "completed_with_errors" | "failed";
      importRunId: string;
      stats: GbpSyncStats;
    };

/** Compare two RFC3339 timestamps by instant (precision-insensitive). */
function isAfter(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b);
}

/**
 * Run one connection sync end to end. Callers hold the connection's
 * `SyncLock` — this function assumes it is the only sync in flight for
 * `input.connectionId`.
 */
export async function syncGoogleConnection(
  deps: GbpSyncDeps,
  input: GbpSyncInput,
): Promise<GbpSyncOutcome> {
  const now = deps.now ?? Date.now;
  // `googleLocationName`/`v4LocationName` are Google resource ids
  // (`locations/2`, `accounts/1/locations/2`), not user data — safe to
  // exempt from the /name/i redaction.
  const log = deps.log.child(
    { connectionId: input.connectionId, trigger: input.trigger },
    { allowUnsafe: ["googleLocationName", "v4LocationName"] },
  );

  const connection = await deps.store.getConnection(input.connectionId);
  if (!connection) {
    log.warn("gbp.sync.skipped", { reason: "not_found" });
    return { outcome: "skipped", reason: "not_found" };
  }
  const logp = log.child({ practiceId: connection.practiceId });
  if (connection.status !== "active") {
    logp.info("gbp.sync.skipped", {
      reason: "not_active",
      connectionStatus: connection.status,
    });
    return { outcome: "skipped", reason: "not_active" };
  }
  if (connection.encryptedCredentials === null) {
    // active-with-no-ciphertext violates the schema invariant — loud.
    logp.error("gbp.sync.skipped", { reason: "no_credentials" });
    return { outcome: "skipped", reason: "no_credentials" };
  }

  // The #121 polling contract: mapped AND verified locations only.
  const { active, excluded } = getActiveMappings(connection);
  // #121 requirement 7: say what was excluded and why, every poll.
  for (const exclusion of excluded) {
    logp.debug("gbp.sync.location_excluded", { ...exclusion });
  }
  if (active.length === 0) {
    logp.info("gbp.sync.skipped", {
      reason: "no_locations",
      excludedCount: excluded.length,
    });
    return { outcome: "skipped", reason: "no_locations" };
  }

  // Narrowed aliases: TS cannot carry the null/active checks above into
  // the closures below.
  const connectionId = connection.id;
  const practiceId = connection.practiceId;

  const credentials = await deps.decryptCredentials(
    connection.encryptedCredentials,
  );
  const cursors = readGoogleSyncCursors(connection.metadata);
  const run = await deps.store.createImportRun({
    practiceId,
    trigger: input.trigger,
  });
  const logr = logp.child({ importRunId: run.id });

  const stats: GbpSyncStats = {
    locationsPolled: 0,
    locationsErrored: 0,
    locationsExcluded: excluded.length,
    pagesFetched: 0,
    pagesStored: 0,
    reviewsSeen: 0,
    cursorsAdvanced: 0,
  };

  // -- global pacing inside the sync: sequential locations, ≥250 ms between
  //    Google calls (see gbpPolling.ts for the shared-quota math).
  let lastRequestAtMs = 0;
  async function pacedListReviewsPage(
    v4LocationName: string,
    pageToken: string | undefined,
  ): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      const waitMs = lastRequestAtMs + GBP_MIN_REQUEST_INTERVAL_MS - now();
      if (waitMs > 0) await deps.sleep(waitMs);
      lastRequestAtMs = now();
      try {
        // Token first (cached while fresh; single-flighted refresh). A
        // NeedsReauthError from here aborts the whole sync below.
        const accessToken = await deps.getAccessToken({
          id: connectionId,
          refreshToken: credentials.refreshToken,
        });
        return await deps.listReviewsPage({
          accessToken,
          googleLocationName: v4LocationName,
          pageToken,
        });
      } catch (error) {
        const retryable =
          (error instanceof GbpApiError && error.retryable) ||
          // Non-invalid_grant token-endpoint failures are transient by the
          // #118 provider's contract (invalid_grant throws NeedsReauthError).
          error instanceof GoogleOAuthError;
        if (!retryable || attempt >= GBP_BACKOFF_MAX_ATTEMPTS) throw error;
        const delayMs = gbpBackoffDelayMs(attempt, {
          retryAfterMs:
            error instanceof GbpApiError ? error.retryAfterMs : undefined,
          ...(deps.random ? { random: deps.random } : {}),
        });
        logr.warn("gbp.sync.request_retry", {
          v4LocationName,
          attempt,
          delayMs: Math.round(delayMs),
          status: error instanceof GbpApiError ? error.status : undefined,
        });
        await deps.sleep(delayMs);
      }
    }
  }

  const runArtifactKeys: string[] = [];
  async function storePageAndEnqueue(
    v4LocationName: string,
    rawPage: unknown,
  ): Promise<void> {
    const envelope = {
      kind: GOOGLE_REVIEWS_ARTIFACT_KIND,
      envelopeVersion: 1,
      practiceId,
      // The v4 account-scoped name — the #125 envelope contract (the
      // adapter emits it as the signal's locationHint; normalize resolves
      // it via the #121 mapping).
      googleLocationName: v4LocationName,
      fetchedAt: new Date(now()).toISOString(),
      // The ORIGINAL parsed object, not the zod output: `page` must be the
      // exact JSON Google returned, key order included (#125 envelope
      // contract — raw artifacts are byte-for-byte provenance).
      page: rawPage as GbpReviewsPage,
    } satisfies GoogleReviewsArtifact;
    // Serialize ONCE and hand that exact string to the content-addressed
    // store (#100 — re-serializing elsewhere invites key mismatches).
    const content = JSON.stringify(envelope);
    const { key } = await putRawArtifact(deps.bucket, {
      practiceId,
      sourceKind: "google",
      content,
    });
    // Store-before-enqueue, in BOTH senses: the artifact is durable in R2
    // AND recorded on the run row (dedupe's conflict_reimport re-reads the
    // run's keys, #106/#111) before the message referencing them exists.
    if (!runArtifactKeys.includes(key)) {
      runArtifactKeys.push(key);
      await deps.store.recordRunArtifactKeys(run.id, [...runArtifactKeys]);
    }
    await deps.ingest.send({
      importRunId: run.id,
      rawArtifactKey: key,
      sourceKind: "google",
      practiceId,
      requestId: input.requestId,
    });
    stats.pagesStored++;
  }

  /** Walk one mapped location newest-first until already-seen territory. */
  async function syncLocation(mapping: ActiveGoogleMapping): Promise<void> {
    // Cursor keyed by the STABLE v1 identity; fetched under the v4 parent.
    const cursor = cursors[mapping.googleLocationName];
    const locationLog = logr.child({
      googleLocationName: mapping.googleLocationName,
      v4LocationName: mapping.v4LocationName,
    });
    let pageToken: string | undefined;
    let maxUpdateTime = cursor;
    let pages = 0;
    let storedAnything = false;
    let sawUnparseablePage = false;

    while (true) {
      if (pages >= GBP_MAX_PAGES_PER_LOCATION) {
        // Runaway guard. Honest limitation: the walk is newest-first, so
        // an updateTime cursor cannot resume a capped FIRST sync — history
        // older than cap×50 (~1,000) reviews is not backfilled (issue #123
        // sized the cap on "hundreds of reviews, not millions"). On
        // incremental syncs the cap only bites if >1,000 reviews changed
        // inside one poll interval, i.e. never in practice.
        locationLog.warn("gbp.sync.page_cap_hit", {
          pages,
          cap: GBP_MAX_PAGES_PER_LOCATION,
          olderHistoryNotBackfilled: cursor === undefined,
        });
        break;
      }
      const rawPage = await pacedListReviewsPage(
        mapping.v4LocationName,
        pageToken,
      );
      pages++;
      stats.pagesFetched++;

      const parsed = gbpReviewsPageSchema.safeParse(rawPage);
      if (!parsed.success) {
        // Shape drift from Google. Store + enqueue anyway: the artifact is
        // provenance and the adapter fails it loudly (non-retryable,
        // recorded on this run — #125's intended path). No cursor advance,
        // no poller-side retry loop: the next tick re-sends once.
        locationLog.warn("gbp.sync.page_unparseable", { pages });
        await storePageAndEnqueue(mapping.v4LocationName, rawPage);
        sawUnparseablePage = true;
        break;
      }
      const reviews = parsed.data.reviews ?? [];
      const newReviews =
        cursor === undefined
          ? reviews
          : reviews.filter((review) => isAfter(review.updateTime, cursor));

      if (newReviews.length === 0) {
        // Nothing unseen (empty location, or an incremental tick with no
        // changes) — nothing to store, and no deeper page can be newer.
        break;
      }

      await storePageAndEnqueue(mapping.v4LocationName, rawPage);
      storedAnything = true;
      stats.reviewsSeen += newReviews.length;
      for (const review of newReviews) {
        if (
          maxUpdateTime === undefined ||
          isAfter(review.updateTime, maxUpdateTime)
        ) {
          maxUpdateTime = review.updateTime;
        }
      }
      // Free drift check against what the pipeline ingests (spike #117):
      // the list response carries location-wide totals on every page.
      locationLog.info("gbp.sync.page_stored", {
        pageIndex: pages,
        newReviews: newReviews.length,
        pageReviews: reviews.length,
        totalReviewCount: parsed.data.totalReviewCount,
        averageRating: parsed.data.averageRating,
      });

      pageToken = parsed.data.nextPageToken;
      // Stop when this page dipped into already-seen territory (the walk
      // is newest-first) or Google says there is no further page.
      if (newReviews.length < reviews.length || pageToken === undefined) {
        break;
      }
    }

    stats.locationsPolled++;
    // An unparseable page blocks the advance even when earlier pages
    // stored fine: advancing past it would permanently skip its reviews.
    // Held back, the next tick re-walks to the same page (earlier pages
    // re-send; dedupe absorbs them) — a visible once-per-tick drumbeat
    // until the shape drift is fixed, after which the walk recovers.
    if (!sawUnparseablePage && storedAnything && maxUpdateTime !== undefined) {
      // ONLY now — every page above is durable in R2 and enqueued. Persist
      // the full map (this sync holds the lock; nothing else writes it).
      cursors[mapping.googleLocationName] = maxUpdateTime;
      await deps.store.saveSyncCursors(connectionId, { ...cursors });
      stats.cursorsAdvanced++;
      locationLog.info("gbp.sync.cursor_advanced", {
        cursorFrom: cursor,
        cursorTo: maxUpdateTime,
      });
    }
  }

  let quotaAborted = false;
  let needsReauth = false;
  for (const mapping of active) {
    try {
      await syncLocation(mapping);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof NeedsReauthError) {
        // Status already durable via the provider's onInvalidGrant hook.
        needsReauth = true;
        await deps.store.recordRunError(run.id, {
          stage: "poll",
          message,
          payloadRef: JSON.stringify({
            connectionId,
            googleLocationName: mapping.googleLocationName,
          }),
        });
        logr.error("gbp.sync.needs_reauth", {
          googleLocationName: mapping.googleLocationName,
        });
        break;
      }
      await deps.store.recordRunError(run.id, {
        stage: "poll",
        message,
        payloadRef: JSON.stringify({
          connectionId,
          googleLocationName: mapping.googleLocationName,
        }),
      });
      if (
        (error instanceof GbpApiError && error.retryable) ||
        error instanceof GoogleOAuthError
      ) {
        // Backoff exhausted against quota/transient errors: abort the
        // REMAINDER gracefully. Cursors already advanced stay advanced;
        // the next cron tick resumes from them.
        quotaAborted = true;
        logr.warn("gbp.sync.quota_aborted", {
          googleLocationName: mapping.googleLocationName,
          status: error instanceof GbpApiError ? error.status : undefined,
          remainingLocations: active.length - active.indexOf(mapping) - 1,
        });
        break;
      }
      // Permanent per-location failure (404 gone, etc.): skip it, keep
      // polling the rest.
      stats.locationsErrored++;
      logr.error("gbp.sync.location_failed", {
        googleLocationName: mapping.googleLocationName,
        error,
      });
    }
  }

  const status: "completed" | "completed_with_errors" | "failed" = needsReauth
    ? "failed"
    : quotaAborted || stats.locationsErrored > 0
      ? "completed_with_errors"
      : "completed";

  await deps.store.accumulateRunStats(run.id, {
    locations_polled: stats.locationsPolled,
    locations_errored: stats.locationsErrored,
    locations_excluded: stats.locationsExcluded,
    pages_fetched: stats.pagesFetched,
    pages_stored: stats.pagesStored,
    reviews_seen: stats.reviewsSeen,
    cursors_advanced: stats.cursorsAdvanced,
    ...(quotaAborted ? { quota_aborted: 1 } : {}),
  });
  await deps.store.finalizeRun(run.id, status);
  if (!needsReauth) {
    await deps.store.setLastSyncAt(connectionId);
  }

  // The requirement-8 line: one greppable summary per sync — the runbook's
  // raw material.
  logr.info("gbp.sync.finished", { syncStatus: status, ...stats });
  return { outcome: status, importRunId: run.id, stats };
}
