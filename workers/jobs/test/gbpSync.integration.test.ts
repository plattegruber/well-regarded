/**
 * GBP sync integration tests (issue #123): the sync engine with its REAL
 * drizzle store against real Postgres (packages/db's template-clone
 * harness), driven by the in-process fake GBP server (#130). No real
 * Google call anywhere; R2 and the queue are in-memory fakes (their real
 * counterparts are exercised by workers/pipeline's tests).
 *
 * Covered end to end: first poll walks full history and persists cursors
 * in `source_connections.metadata.syncCursors`; second poll is incremental
 * (new + edited only); stored artifacts are #125 envelopes the merged
 * adapter actually normalizes; 429 exhaustion finalizes
 * `completed_with_errors` with the error sample recorded and later
 * resumes; `invalid_grant` durably flips the connection to `needs_reauth`
 * with a system-actor audit row and a `failed` run.
 */

import {
  createLogger,
  decryptField,
  encryptField,
  type GoogleConnectionCredentials,
  type IngestMessage,
} from "@wellregarded/core";
import { schema } from "@wellregarded/db";
import {
  createGoogleAccessTokenProvider,
  type GoogleReviewsArtifact,
  googleReviewsAdapter,
  googleReviewsArtifactSchema,
  listGbpReviewsPage,
} from "@wellregarded/sources";
import { createFakeGbp, type FakeGbp } from "@wellregarded/sources/google/fake";
import { InMemoryRawArtifactBucket } from "@wellregarded/sources/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  practice,
  sourceConnection,
  TEST_KEYRING,
} from "../../../packages/db/test/factories.js";
import { setupTestDb } from "../../../packages/db/test/harness.js";
import { type GbpSyncDeps, syncGoogleConnection } from "../src/gbpSync";
import { createGbpSyncStore, persistNeedsReauth } from "../src/gbpSyncStore";

const { auditLog, importRuns, sourceConnections } = schema;

const t = setupTestDb();

interface Harness {
  fake: FakeGbp;
  deps: GbpSyncDeps;
  bucket: InMemoryRawArtifactBucket;
  sent: IngestMessage[];
  connectionId: string;
  practiceId: string;
}

/**
 * A practice with a Google connection whose (encrypted) refresh token the
 * fake server honors, discovered-location snapshot included — the state
 * #118 + #121 leave behind.
 */
async function harness(options: { locations?: number } = {}): Promise<Harness> {
  const fake = createFakeGbp();
  fake.store.addAccount();
  const locationCount = options.locations ?? 2;
  for (let i = 0; i < locationCount; i++) fake.store.addLocation();

  const granted = fake.store.exchangeAuthCode(fake.store.issueAuthCode());
  if (!granted?.refreshToken) throw new Error("fake grant failed");

  const p = await practice(t.db);
  const connection = await sourceConnection(t.db, {
    practiceId: p.id,
    kind: "google",
    status: "active",
    encryptedCredentials: await encryptField(
      JSON.stringify({
        refreshToken: granted.refreshToken,
        obtainedAt: new Date().toISOString(),
      }),
      TEST_KEYRING,
    ),
    // The state #118 + #121 leave behind: encrypted credentials, the
    // discovered snapshot, and explicit mapping decisions.
    metadata: {
      googleLocations: Array.from({ length: locationCount }, (_, i) => ({
        googleLocationName: `locations/${i + 1}`,
        googleAccountName: "accounts/1",
        accountDisplayName: "Fake Practice 1",
        title: `Fake Location ${i + 1}`,
        address: "412 Cedar Ridge Ave, Grand Rapids, MI 49503",
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

  const gbpFetch: typeof fetch = async (input, init) =>
    fake.app.fetch(new Request(input, init));

  const tokenProvider = createGoogleAccessTokenProvider({
    config: {
      tokenUrl: "http://fake-gbp.local/oauth/token",
      clientId: "client",
      clientSecret: "secret",
      fetch: gbpFetch,
    },
    // The REAL persistence hook the runtime wires (status + audit in one
    // transaction) — what the needs_reauth test asserts on.
    onInvalidGrant: (connectionId) => persistNeedsReauth(t.db, connectionId),
  });

  const bucket = new InMemoryRawArtifactBucket();
  const sent: IngestMessage[] = [];

  const deps: GbpSyncDeps = {
    store: createGbpSyncStore(t.db),
    bucket,
    ingest: {
      send: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    },
    getAccessToken: (connection) => tokenProvider.getAccessToken(connection),
    decryptCredentials: async (ciphertext) =>
      JSON.parse(
        await decryptField(ciphertext, TEST_KEYRING),
      ) as GoogleConnectionCredentials,
    listReviewsPage: (input) =>
      listGbpReviewsPage(
        { v4BaseUrl: "http://fake-gbp.local", fetch: gbpFetch },
        input,
      ),
    log: createLogger({
      worker: "jobs",
      requestId: "req-integration",
      level: "error",
      sink: () => {},
    }),
    sleep: () => Promise.resolve(),
    random: () => 1,
  };

  return {
    fake,
    deps,
    bucket,
    sent,
    connectionId: connection.id,
    practiceId: p.id,
  };
}

const input = (connectionId: string) =>
  ({ connectionId, trigger: "cron", requestId: "req-integration" }) as const;

async function connectionRow(id: string) {
  const [row] = await t.db
    .select()
    .from(sourceConnections)
    .where(eq(sourceConnections.id, id));
  if (!row) throw new Error("connection row vanished");
  return row;
}

async function runRows(practiceId: string) {
  return t.db
    .select()
    .from(importRuns)
    .where(eq(importRuns.practiceId, practiceId));
}

describe("first poll", () => {
  it("walks full history, stores envelopes the adapter normalizes, persists cursors + last_sync_at, finalizes the run", async () => {
    const h = await harness();
    const r1 = h.fake.store.addReview({
      location: "accounts/1/locations/1",
      comment: "Painless filling, kind hygienist",
    });
    // Star-only review: no comment — still a signal.
    h.fake.store.addReview({
      location: "accounts/1/locations/1",
      starRating: "FOUR",
    });
    const r3 = h.fake.store.addReview({
      location: "accounts/1/locations/2",
      comment: "Front desk was lovely",
    });

    const outcome = await syncGoogleConnection(h.deps, input(h.connectionId));
    expect(outcome.outcome).toBe("completed");

    // One import run, finalized `completed`, with the sync stats recorded.
    const runs = await runRows(h.practiceId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      sourceKind: "google",
      trigger: "cron",
      status: "completed",
    });
    expect(runs[0]?.finishedAt).not.toBeNull();
    expect(runs[0]?.stats).toMatchObject({
      locations_polled: 2,
      pages_stored: 2,
      reviews_seen: 3,
      cursors_advanced: 2,
    });
    // Dedupe's conflict_reimport contract (#106/#111): the run row records
    // every artifact key this sync stored.
    expect([...(runs[0]?.rawArtifactKeys ?? [])].sort()).toEqual(
      h.sent.map((message) => message.rawArtifactKey).sort(),
    );

    // Cursors persisted in connection metadata, per location.
    const row = await connectionRow(h.connectionId);
    const metadata = row.metadata as {
      syncCursors?: Record<string, string>;
      googleLocations?: unknown[];
      locationMappings?: unknown[];
    };
    // Keyed by the STABLE v1 identity (the #121 mapping key).
    expect(metadata.syncCursors).toEqual({
      "locations/1": expect.any(String),
      "locations/2": r3.updateTime,
    });
    // The per-key metadata patch left the #121 keys untouched.
    expect(metadata.googleLocations).toHaveLength(2);
    expect(metadata.locationMappings).toHaveLength(2);
    expect(row.lastSyncAt).not.toBeNull();

    // Every enqueued message references a durable artifact that IS a valid
    // #125 envelope — and the merged adapter turns it into signals.
    expect(h.sent).toHaveLength(2);
    for (const message of h.sent) {
      expect(message.importRunId).toBe(runs[0]?.id);
      const object = h.bucket.objects.get(message.rawArtifactKey);
      expect(object).toBeDefined();
      const artifact = googleReviewsArtifactSchema.parse(
        JSON.parse(new TextDecoder().decode(object?.body)),
      ) as GoogleReviewsArtifact;
      const signals = await googleReviewsAdapter.normalize(artifact);
      expect(signals.length).toBeGreaterThan(0);
      for (const signal of signals) {
        expect(signal.locationHint?.text).toBe(artifact.googleLocationName);
      }
    }
    const allSignals = (
      await Promise.all(
        h.sent.map((message) => {
          const object = h.bucket.objects.get(message.rawArtifactKey);
          return googleReviewsAdapter.normalize(
            JSON.parse(new TextDecoder().decode(object?.body)),
          );
        }),
      )
    ).flat();
    expect(allSignals.map((signal) => signal.sourceId).sort()).toEqual(
      [r1.name, "accounts/1/locations/1/reviews/2", r3.name].sort(),
    );
  });
});

describe("second poll", () => {
  it("is incremental: exactly the new + edited reviews re-enter the pipeline", async () => {
    const h = await harness();
    h.fake.store.addReview({
      location: "accounts/1/locations/1",
      comment: "Original review",
    });
    const toEdit = h.fake.store.addReview({
      location: "accounts/1/locations/2",
      comment: "Pre-edit text",
    });
    await syncGoogleConnection(h.deps, input(h.connectionId));
    h.sent.length = 0;

    const added = h.fake.store.addReview({
      location: "accounts/1/locations/1",
      comment: "New since last poll",
    });
    const edited = h.fake.store.editReview(toEdit.name, {
      comment: "Edited since last poll",
    });

    const outcome = await syncGoogleConnection(h.deps, input(h.connectionId));
    expect(outcome.outcome).toBe("completed");
    if (outcome.outcome !== "completed") throw new Error("unreachable");
    expect(outcome.stats.reviewsSeen).toBe(2);
    expect(h.sent).toHaveLength(2);

    const row = await connectionRow(h.connectionId);
    const cursors = (row.metadata as { syncCursors: Record<string, string> })
      .syncCursors;
    expect(cursors["locations/1"]).toBe(added.updateTime);
    expect(cursors["locations/2"]).toBe(edited.updateTime);

    // Two runs on the books now, both completed.
    const runs = await runRows(h.practiceId);
    expect(runs.map((run) => run.status)).toEqual(["completed", "completed"]);
  });
});

describe("429 path", () => {
  it("backs off, aborts gracefully as completed_with_errors with the quota error recorded, and resumes next poll", async () => {
    const h = await harness();
    h.fake.store.addReview({
      location: "accounts/1/locations/1",
      comment: "Location 1",
    });
    h.fake.store.addReview({
      location: "accounts/1/locations/2",
      comment: "Location 2",
    });
    h.fake.store.failNext("GET /v4/accounts/1/locations/2/reviews", {
      status: 429,
      times: 3,
    });

    const first = await syncGoogleConnection(h.deps, input(h.connectionId));
    expect(first.outcome).toBe("completed_with_errors");

    const [run] = await runRows(h.practiceId);
    expect(run?.status).toBe("completed_with_errors");
    expect(run?.failed).toBe(1);
    expect(run?.errorSamples[0]?.message).toContain("429");
    expect(run?.stats).toMatchObject({ quota_aborted: 1 });

    // Location 1's cursor survived the abort; location 2 has none yet.
    const row = await connectionRow(h.connectionId);
    const cursors = (row.metadata as { syncCursors: Record<string, string> })
      .syncCursors;
    expect(cursors["locations/1"]).toBeDefined();
    expect(cursors["locations/2"]).toBeUndefined();

    // Quota recovered: the next poll picks up exactly what was missed.
    h.sent.length = 0;
    const second = await syncGoogleConnection(h.deps, input(h.connectionId));
    expect(second.outcome).toBe("completed");
    expect(h.sent).toHaveLength(1);
  });
});

describe("needs_reauth path", () => {
  it("invalid_grant flips the connection durably, audits as system, finalizes the run failed", async () => {
    const h = await harness({ locations: 1 });
    h.fake.store.addReview({ comment: "Unreachable behind dead grant" });
    h.fake.store.failNext("POST /oauth/token", {
      status: 400,
      body: { error: "invalid_grant" },
    });

    const outcome = await syncGoogleConnection(h.deps, input(h.connectionId));
    expect(outcome.outcome).toBe("failed");

    // The connection is durably needs_reauth — what the settings card and
    // the Today screen read.
    const row = await connectionRow(h.connectionId);
    expect(row.status).toBe("needs_reauth");
    // Credentials are kept (re-auth overwrites them; disconnect erases).
    expect(row.encryptedCredentials).not.toBeNull();
    expect(row.lastSyncAt).toBeNull();

    // System-actor audit row for the transition.
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.practiceId, h.practiceId));
    const entry = audits.find(
      (a) => a.action === "source_connection.needs_reauth",
    );
    expect(entry).toMatchObject({
      actorType: "system",
      actorId: "jobs:gbp-sync",
      entityType: "source_connections",
      entityId: h.connectionId,
    });

    // The run is failed with the reason recorded; nothing was enqueued.
    const [run] = await runRows(h.practiceId);
    expect(run?.status).toBe("failed");
    expect(run?.errorSamples[0]?.message).toContain("invalid_grant");
    expect(h.sent).toHaveLength(0);

    // A later poll of a needs_reauth connection is a clean skip (the cron
    // enumeration filters on active anyway; the DO double-checks).
    const again = await syncGoogleConnection(h.deps, input(h.connectionId));
    expect(again).toEqual({ outcome: "skipped", reason: "not_active" });
  });
});
