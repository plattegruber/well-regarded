/**
 * Unit tests for the GBP sync engine (issue #123), driven by the
 * in-process fake GBP server (#130) with a fake store — no Postgres, no
 * network, no timers (sleep is recorded, never waited).
 *
 * Covered here: full first sync, incremental second sync via the
 * updateTime cursor, store-before-enqueue ordering, crash-safe cursor
 * advance, envelope byte-exactness, 429 backoff + graceful abort,
 * invalid_grant → NeedsReauth, the page cap, unparseable pages, and the
 * skip reasons. The same flows against real Postgres live in
 * test/gbpSync.integration.test.ts.
 */

import {
  createLogger,
  type IngestMessage,
  type Logger,
} from "@wellregarded/core";
import {
  createGoogleAccessTokenProvider,
  googleReviewsArtifactSchema,
  listGbpReviewsPage,
} from "@wellregarded/sources";
import { createFakeGbp } from "@wellregarded/sources/google/fake";
import { InMemoryRawArtifactBucket } from "@wellregarded/sources/testing";
import { describe, expect, it, vi } from "vitest";

import { GBP_MAX_PAGES_PER_LOCATION } from "./gbpPolling";
import {
  type GbpSyncConnectionRow,
  type GbpSyncDeps,
  type GbpSyncStore,
  syncGoogleConnection,
} from "./gbpSync";

const CONNECTION_ID = "3f2b6a1e-90cd-4f5e-8a2f-1b0f4a7c9d21";
const PRACTICE_ID = "8a9c1a52-6a54-4d43-9c39-9d5df2bb0e1a";
const REQUEST_ID = "req-test-1";

interface FakeStoreState {
  store: GbpSyncStore;
  /** Ordered event names, for store-before-enqueue style assertions. */
  events: string[];
  runs: Array<{ id: string; practiceId: string; trigger: string }>;
  errors: Array<{ importRunId: string; message: string }>;
  statsPatches: Array<Record<string, number>>;
  finalized: Array<{ importRunId: string; status: string }>;
  cursors: Record<string, string>;
  runArtifactKeys: string[];
  lastSyncAtCount: number;
  metadata: Record<string, unknown>;
}

function fakeStore(
  connection:
    | (Partial<GbpSyncConnectionRow> & { metadata: Record<string, unknown> })
    | null,
): FakeStoreState {
  const state = {} as FakeStoreState;
  let runCounter = 0;
  state.events = [];
  state.runs = [];
  state.errors = [];
  state.statsPatches = [];
  state.finalized = [];
  state.cursors = {};
  state.runArtifactKeys = [];
  state.lastSyncAtCount = 0;
  state.metadata = connection?.metadata ?? {};
  state.store = {
    getConnection: (connectionId) =>
      Promise.resolve(
        connection === null
          ? null
          : {
              id: connectionId,
              practiceId: PRACTICE_ID,
              status: "active",
              encryptedCredentials: "v1:fake:ciphertext",
              ...connection,
              metadata: state.metadata,
            },
      ),
    createImportRun: (input) => {
      const id = `run-${++runCounter}`;
      state.runs.push({ id, ...input });
      state.events.push(`createRun:${id}`);
      return Promise.resolve({ id });
    },
    recordRunError: (importRunId, sample) => {
      state.errors.push({ importRunId, message: sample.message });
      state.events.push("recordError");
      return Promise.resolve();
    },
    accumulateRunStats: (_importRunId, stats) => {
      state.statsPatches.push(stats);
      return Promise.resolve();
    },
    finalizeRun: (importRunId, status) => {
      state.finalized.push({ importRunId, status });
      state.events.push(`finalize:${status}`);
      return Promise.resolve();
    },
    recordRunArtifactKeys: (_importRunId, keys) => {
      state.runArtifactKeys = [...keys];
      state.events.push(`keys:${keys.length}`);
      return Promise.resolve();
    },
    saveSyncCursors: (_connectionId, cursors) => {
      state.cursors = { ...cursors };
      // Mirror the real store: the next getConnection sees the cursors.
      state.metadata = { ...state.metadata, syncCursors: { ...cursors } };
      state.events.push(`cursor:${Object.keys(cursors).length}`);
      return Promise.resolve();
    },
    setLastSyncAt: () => {
      state.lastSyncAtCount++;
      state.events.push("lastSyncAt");
      return Promise.resolve();
    },
  };
  return state;
}

function quietLogger(): Logger {
  return createLogger({
    worker: "jobs",
    requestId: REQUEST_ID,
    level: "debug",
    sink: () => {},
  });
}

/** Two verified locations under one account, like a two-office practice. */
function seededHarness(options: { locations?: number } = {}) {
  const fake = createFakeGbp();
  fake.store.addAccount();
  const locationCount = options.locations ?? 2;
  for (let i = 0; i < locationCount; i++) fake.store.addLocation();

  const gbpFetch: typeof fetch = async (input, init) =>
    fake.app.fetch(new Request(input, init));

  // The state #121 leaves behind: a discovered snapshot plus explicit
  // mapping decisions — only mapped + verified locations poll.
  const storeState = fakeStore({
    metadata: {
      googleLocations: Array.from({ length: locationCount }, (_, i) => ({
        googleLocationName: `locations/${i + 1}`,
        googleAccountName: "accounts/1",
        accountDisplayName: "Fake Practice 1",
        title: `Fake Location ${i + 1}`,
        address: "",
        verificationState: "verified",
        discoveredAt: "2026-07-01T00:00:00.000Z",
      })),
      locationMappings: Array.from({ length: locationCount }, (_, i) => ({
        googleLocationName: `locations/${i + 1}`,
        locationId: `0c8e4bde-6a1f-4f3e-9f43-0a4be1e0e00${i + 1}`,
        mappedBy: null,
        mappedAt: "2026-07-01T00:00:00.000Z",
      })),
    },
  });

  const bucket = new InMemoryRawArtifactBucket();
  const sent: IngestMessage[] = [];
  const sleeps: number[] = [];
  const onInvalidGrant = vi.fn(() => Promise.resolve());

  // The real #118 provider against the fake token endpoint — refresh,
  // caching and invalid_grant behave exactly as in production.
  const tokenProvider = createGoogleAccessTokenProvider({
    config: {
      tokenUrl: "http://fake-gbp.local/oauth/token",
      clientId: "client",
      clientSecret: "secret",
      fetch: gbpFetch,
    },
    onInvalidGrant,
  });

  const refreshToken = (() => {
    const code = fake.store.issueAuthCode();
    const granted = fake.store.exchangeAuthCode(code);
    if (!granted?.refreshToken) throw new Error("fake grant failed");
    return granted.refreshToken;
  })();

  const deps: GbpSyncDeps = {
    store: storeState.store,
    bucket,
    ingest: {
      send: (message) => {
        sent.push(message);
        storeState.events.push(`send:${message.rawArtifactKey}`);
        return Promise.resolve();
      },
    },
    getAccessToken: (connection) => tokenProvider.getAccessToken(connection),
    decryptCredentials: () =>
      Promise.resolve({
        refreshToken,
        obtainedAt: new Date().toISOString(),
      }),
    listReviewsPage: (input) =>
      listGbpReviewsPage(
        { v4BaseUrl: "http://fake-gbp.local", fetch: gbpFetch },
        input,
      ),
    log: quietLogger(),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 1,
  };

  return { fake, storeState, bucket, sent, sleeps, deps, onInvalidGrant };
}

const input = {
  connectionId: CONNECTION_ID,
  trigger: "cron",
  requestId: REQUEST_ID,
} as const;

describe("syncGoogleConnection — first sync", () => {
  it("stores one artifact per location page, enqueues, advances cursors, completes", async () => {
    const h = seededHarness();
    const r1 = h.fake.store.addReview({
      location: "accounts/1/locations/1",
      comment: "Great cleaning",
    });
    const r2 = h.fake.store.addReview({
      location: "accounts/1/locations/1",
      comment: "Friendly staff",
    });
    const r3 = h.fake.store.addReview({
      location: "accounts/1/locations/2",
      comment: "Short wait",
    });

    const outcome = await syncGoogleConnection(h.deps, input);
    expect(outcome.outcome).toBe("completed");

    // One page per location, stored and enqueued.
    expect(h.bucket.objects.size).toBe(2);
    expect(h.sent).toHaveLength(2);
    for (const message of h.sent) {
      expect(message.sourceKind).toBe("google");
      expect(message.practiceId).toBe(PRACTICE_ID);
      expect(message.requestId).toBe(REQUEST_ID);
      expect(message.importRunId).toBe(h.storeState.runs[0]?.id);
      // Store-before-enqueue: the referenced artifact exists.
      expect(h.bucket.objects.has(message.rawArtifactKey)).toBe(true);
    }

    // Every stored artifact is a valid #125 envelope with the VERBATIM page.
    const artifacts = [...h.bucket.objects.values()].map((object) =>
      googleReviewsArtifactSchema.parse(
        JSON.parse(new TextDecoder().decode(object.body)),
      ),
    );
    const reviewNames = artifacts.flatMap(
      (artifact) => artifact.page.reviews?.map((review) => review.name) ?? [],
    );
    expect(reviewNames.sort()).toEqual([r1.name, r2.name, r3.name].sort());

    // Cursors = max updateTime per location, keyed by the STABLE v1 name,
    // advanced only after the page was stored, recorded on the run, and
    // enqueued (in that order).
    expect(h.storeState.cursors["locations/1"]).toBe(r2.updateTime);
    expect(h.storeState.cursors["locations/2"]).toBe(r3.updateTime);
    const events = h.storeState.events;
    const firstSend = events.findIndex((event) => event.startsWith("send:"));
    expect(events.findIndex((e) => e.startsWith("cursor:"))).toBeGreaterThan(
      firstSend,
    );
    // Dedupe's conflict_reimport contract: the run's artifact keys are
    // durable BEFORE the first message referencing the run is enqueued.
    expect(events.findIndex((e) => e.startsWith("keys:"))).toBeLessThan(
      firstSend,
    );
    expect(h.storeState.runArtifactKeys.sort()).toEqual(
      h.sent.map((message) => message.rawArtifactKey).sort(),
    );

    expect(h.storeState.finalized).toEqual([
      { importRunId: "run-1", status: "completed" },
    ]);
    expect(h.storeState.lastSyncAtCount).toBe(1);
    expect(h.storeState.statsPatches[0]).toMatchObject({
      locations_polled: 2,
      pages_stored: 2,
      reviews_seen: 3,
      cursors_advanced: 2,
    });
  });

  it("walks multiple pages when a location has more than one page of reviews", async () => {
    const h = seededHarness({ locations: 1 });
    for (let i = 0; i < 55; i++) {
      h.fake.store.addReview({ comment: `Review ${i}` });
    }
    const outcome = await syncGoogleConnection(h.deps, input);
    expect(outcome.outcome).toBe("completed");
    expect(h.bucket.objects.size).toBe(2); // 50 + 5
    expect(h.storeState.statsPatches[0]).toMatchObject({
      pages_fetched: 2,
      pages_stored: 2,
      reviews_seen: 55,
    });
  });
});

describe("syncGoogleConnection — incremental", () => {
  it("second sync fetches exactly the new + edited reviews", async () => {
    const h = seededHarness();
    h.fake.store.addReview({
      location: "accounts/1/locations/1",
      comment: "Original",
    });
    const stays = h.fake.store.addReview({
      location: "accounts/1/locations/2",
      comment: "Untouched",
    });
    await syncGoogleConnection(h.deps, input);
    expect(h.sent).toHaveLength(2);
    h.sent.length = 0;

    // A brand-new review and an edit — both must re-enter the pipeline.
    const added = h.fake.store.addReview({
      location: "accounts/1/locations/1",
      comment: "Brand new",
    });
    const edited = h.fake.store.editReview(stays.name, {
      comment: "Edited on Google",
    });

    const outcome = await syncGoogleConnection(h.deps, input);
    expect(outcome.outcome).toBe("completed");
    if (outcome.outcome !== "completed") throw new Error("unreachable");
    // One page per affected location; each page carries old reviews too
    // (VERBATIM), but only the new/edited ones count as seen.
    expect(outcome.stats.reviewsSeen).toBe(2);
    expect(h.sent).toHaveLength(2);

    // Cursors moved to the new max updateTimes.
    expect(h.storeState.cursors["locations/1"]).toBe(added.updateTime);
    expect(h.storeState.cursors["locations/2"]).toBe(edited.updateTime);
  });

  it("a no-change sync stores nothing and leaves cursors alone", async () => {
    const h = seededHarness();
    h.fake.store.addReview({ location: "accounts/1/locations/1" });
    await syncGoogleConnection(h.deps, input);
    const cursorsAfterFirst = { ...h.storeState.cursors };
    h.sent.length = 0;

    const outcome = await syncGoogleConnection(h.deps, input);
    expect(outcome.outcome).toBe("completed");
    if (outcome.outcome !== "completed") throw new Error("unreachable");
    expect(h.sent).toHaveLength(0);
    expect(outcome.stats.pagesStored).toBe(0);
    expect(outcome.stats.pagesFetched).toBe(2); // one look per location
    expect(h.storeState.cursors).toEqual(cursorsAfterFirst);
    // Still a successful sync: finalized + last_sync_at stamped.
    expect(h.storeState.finalized[1]?.status).toBe("completed");
    expect(h.storeState.lastSyncAtCount).toBe(2);
  });
});

describe("syncGoogleConnection — 429/backoff", () => {
  it("retries with the 1s/4s/16s schedule and succeeds after transient 429s", async () => {
    const h = seededHarness({ locations: 1 });
    h.fake.store.addReview({ comment: "Eventually fetched" });
    h.fake.store.failNext("GET /v4/accounts/1/locations/1/reviews", {
      status: 429,
      times: 2,
    });

    const outcome = await syncGoogleConnection(h.deps, input);
    expect(outcome.outcome).toBe("completed");
    expect(h.sent).toHaveLength(1);
    // Two backoff sleeps among the recorded sleeps (pacing sleeps are
    // sub-second): 1s then 4s, both >= the fake's Retry-After (1s).
    const backoffs = h.sleeps.filter((ms) => ms >= 1000);
    expect(backoffs).toEqual([1000, 4000]);
  });

  it("aborts the remainder gracefully on exhaustion: completed_with_errors, cursors kept, next sync resumes", async () => {
    const h = seededHarness();
    const first = h.fake.store.addReview({
      location: "accounts/1/locations/1",
      comment: "Location 1 review",
    });
    h.fake.store.addReview({
      location: "accounts/1/locations/2",
      comment: "Location 2 review",
    });
    // Location 1 syncs clean; location 2 is rate-limited for exactly the
    // retry budget — the sync must stop there, not keep hammering.
    h.fake.store.failNext("GET /v4/accounts/1/locations/2/reviews", {
      status: 429,
      times: 3,
    });

    const outcome = await syncGoogleConnection(h.deps, input);
    expect(outcome.outcome).toBe("completed_with_errors");
    if (outcome.outcome !== "completed_with_errors")
      throw new Error("unreachable");
    // Exactly 3 attempts were made against the limited endpoint (never a
    // busy-loop), and the quota error is recorded on the run.
    expect(h.storeState.errors).toHaveLength(1);
    expect(h.storeState.errors[0]?.message).toContain("429");
    expect(h.storeState.statsPatches[0]).toMatchObject({ quota_aborted: 1 });
    // Location 1's progress is kept.
    expect(h.storeState.cursors["locations/1"]).toBe(first.updateTime);
    expect(h.storeState.cursors["locations/2"]).toBeUndefined();
    expect(h.storeState.finalized[0]?.status).toBe("completed_with_errors");

    // Next sync (quota recovered) picks up exactly the missed location.
    h.sent.length = 0;
    const second = await syncGoogleConnection(h.deps, input);
    expect(second.outcome).toBe("completed");
    expect(h.sent).toHaveLength(1);
    expect(h.storeState.cursors["locations/2"]).toBeDefined();
  });

  it("a permanent per-location failure skips that location and keeps polling", async () => {
    const h = seededHarness();
    h.fake.store.addReview({ location: "accounts/1/locations/2" });
    h.fake.store.failNext("GET /v4/accounts/1/locations/1/reviews", {
      status: 404,
    });

    const outcome = await syncGoogleConnection(h.deps, input);
    expect(outcome.outcome).toBe("completed_with_errors");
    if (outcome.outcome !== "completed_with_errors")
      throw new Error("unreachable");
    expect(outcome.stats.locationsErrored).toBe(1);
    expect(h.sent).toHaveLength(1); // location 2 still synced
    expect(h.storeState.lastSyncAtCount).toBe(1);
  });
});

describe("syncGoogleConnection — needs_reauth", () => {
  it("invalid_grant aborts the sync, fires onInvalidGrant, finalizes failed", async () => {
    const h = seededHarness();
    h.fake.store.addReview({ location: "accounts/1/locations/1" });
    // Revoke the refresh grant Google-side: next refresh → invalid_grant.
    h.fake.store.failNext("POST /oauth/token", {
      status: 400,
      body: { error: "invalid_grant" },
    });

    const outcome = await syncGoogleConnection(h.deps, input);
    expect(outcome.outcome).toBe("failed");
    expect(h.onInvalidGrant).toHaveBeenCalledExactlyOnceWith(CONNECTION_ID);
    expect(h.sent).toHaveLength(0);
    expect(h.storeState.finalized[0]?.status).toBe("failed");
    expect(h.storeState.errors[0]?.message).toContain("invalid_grant");
    // A failed sync never stamps last_sync_at.
    expect(h.storeState.lastSyncAtCount).toBe(0);
  });
});

describe("syncGoogleConnection — guards", () => {
  it("caps pages per location per sync and logs the cap", async () => {
    const h = seededHarness({ locations: 1 });
    // Synthetic endless pages: every page full of never-before-seen
    // reviews with a next token — only the cap stops the walk.
    let page = 0;
    h.deps.listReviewsPage = () => {
      page++;
      return Promise.resolve({
        reviews: Array.from({ length: 50 }, (_, i) => ({
          name: `accounts/1/locations/1/reviews/p${page}-${i}`,
          starRating: "FIVE",
          createTime: "2026-01-01T00:00:00Z",
          updateTime: `2026-06-${String((page % 28) + 1).padStart(2, "0")}T00:00:${String(i % 60).padStart(2, "0")}Z`,
        })),
        nextPageToken: `page-${page + 1}`,
      });
    };

    const outcome = await syncGoogleConnection(h.deps, input);
    expect(outcome.outcome).toBe("completed");
    if (outcome.outcome !== "completed") throw new Error("unreachable");
    expect(outcome.stats.pagesFetched).toBe(GBP_MAX_PAGES_PER_LOCATION);
    expect(outcome.stats.pagesStored).toBe(GBP_MAX_PAGES_PER_LOCATION);
    // Cursor still advanced — the walk resumes from it next tick.
    expect(h.storeState.cursors["locations/1"]).toBeDefined();
  });

  it("an unparseable page AFTER stored pages blocks the cursor advance (no permanent skip)", async () => {
    const h = seededHarness({ locations: 1 });
    // Page 1 parses and stores; page 2 is shape-drifted garbage.
    let call = 0;
    h.deps.listReviewsPage = () => {
      call++;
      if (call === 1) {
        return Promise.resolve({
          reviews: Array.from({ length: 50 }, (_, i) => ({
            name: `accounts/1/locations/1/reviews/${i}`,
            starRating: "FIVE",
            createTime: "2026-06-01T00:00:00Z",
            updateTime: `2026-06-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
          })),
          nextPageToken: "page-2",
        });
      }
      return Promise.resolve({ reviews: [{ name: "shape-drift" }] });
    };

    const outcome = await syncGoogleConnection(h.deps, input);
    expect(outcome.outcome).toBe("completed");
    expect(h.sent).toHaveLength(2); // both pages stored + enqueued
    // Advancing past the drifted page would permanently skip its reviews —
    // the cursor stays put so the next tick re-walks to it.
    expect(h.storeState.cursors).toEqual({});
  });

  it("stores an unparseable page verbatim without advancing the cursor", async () => {
    const h = seededHarness({ locations: 1 });
    const garbage = { reviews: [{ name: "not-a-review-resource-name" }] };
    h.deps.listReviewsPage = () => Promise.resolve(garbage);

    const outcome = await syncGoogleConnection(h.deps, input);
    expect(outcome.outcome).toBe("completed");
    expect(h.sent).toHaveLength(1);
    const stored = JSON.parse(
      new TextDecoder().decode([...h.bucket.objects.values()][0]?.body),
    ) as { page: unknown };
    expect(stored.page).toEqual(garbage); // verbatim provenance
    expect(h.storeState.cursors).toEqual({});
  });

  it("skips when the connection is missing, inactive, or has no locations", async () => {
    const missing = fakeStore(null);
    const h1 = seededHarness();
    h1.deps.store = missing.store;
    expect(await syncGoogleConnection(h1.deps, input)).toEqual({
      outcome: "skipped",
      reason: "not_found",
    });

    const inactive = fakeStore({ status: "needs_reauth", metadata: {} });
    const h2 = seededHarness();
    h2.deps.store = inactive.store;
    expect(await syncGoogleConnection(h2.deps, input)).toEqual({
      outcome: "skipped",
      reason: "not_active",
    });
    expect(inactive.runs).toHaveLength(0);

    const noLocations = fakeStore({ metadata: {} });
    const h3 = seededHarness();
    h3.deps.store = noLocations.store;
    expect(await syncGoogleConnection(h3.deps, input)).toEqual({
      outcome: "skipped",
      reason: "no_locations",
    });
    // No pointless import run for an unconfigured connection.
    expect(noLocations.runs).toHaveLength(0);
  });

  it("paces consecutive Google calls at least 250 ms apart", async () => {
    const h = seededHarness();
    h.fake.store.addReview({ location: "accounts/1/locations/1" });
    h.fake.store.addReview({ location: "accounts/1/locations/2" });
    // A fixed clock makes the pacing math exact: every call appears
    // instantaneous, so each subsequent call must sleep the full interval.
    let clock = 1_000_000;
    h.deps.now = () => clock;
    h.deps.sleep = (ms) => {
      h.sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    };

    await syncGoogleConnection(h.deps, input);
    // Two locations → two list calls; the second waits the pacing gap.
    expect(h.sleeps).toContain(250);
  });
});
