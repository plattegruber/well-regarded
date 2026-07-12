/**
 * Normalize stage end-to-end (issue #104): the real dispatcher + the real
 * wired `normalize` handler against a real Postgres (packages/db's
 * template-clone harness), with fixture artifacts for TWO source kinds in
 * an in-memory R2 bucket.
 *
 * Covers: signals rows created `pending_dedupe` with full provenance,
 * confident hint matches setting FKs vs stored hints, the PII patient seam,
 * `import_runs` counts updated transactionally, dedupe messages enqueued —
 * and idempotent re-delivery routing conflicts to dedupe as potential
 * updates. Failure paths (missing artifact / unknown kind) land on the DLQ
 * path and become visible in the run's error samples.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { resetEnvCache } from "@wellregarded/core";
import { getImportRunSummary, schema } from "@wellregarded/db";
import {
  putRawArtifact,
  registerAdapter,
  resetAdapterRegistry,
} from "@wellregarded/sources";
import {
  csvFixtureAdapter,
  csvFixtureArtifact,
  fixtureArtifact,
  InMemoryRawArtifactBucket,
} from "@wellregarded/sources/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  importRun,
  location,
  practice,
  provider,
} from "../../../packages/db/test/factories.js";
import { setupTestDb } from "../../../packages/db/test/harness.js";
import { handleQueueBatch } from "../src/dispatch";
import {
  fakeMessage,
  type IntegrationEnv,
  integrationEnv,
} from "./support/integrationEnv";

const t = setupTestDb();
const { signals, patients, contactPoints } = schema;

let bucket: InMemoryRawArtifactBucket;
let env: IntegrationEnv;

beforeEach(() => {
  resetEnvCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  bucket = new InMemoryRawArtifactBucket();
  env = integrationEnv(t.databaseName, bucket);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAdapterRegistry();
});

/** A practice with entities matching the manual fixture artifact's hints. */
async function fixturePractice() {
  const p = await practice(t.db);
  const patel = await provider(t.db, {
    practiceId: p.id,
    displayName: "Dr. Patel",
  });
  const mainStreet = await location(t.db, {
    practiceId: p.id,
    name: "Main Street office",
  });
  const run = await importRun(t.db, { practiceId: p.id, sourceKind: "manual" });
  return { p, patel, mainStreet, run };
}

async function storeArtifact(
  practiceId: string,
  sourceKind: "manual" | "csv_import" | "google" | "opendental",
  artifact: unknown,
): Promise<string> {
  const { key } = await putRawArtifact(bucket, {
    practiceId,
    sourceKind,
    content: JSON.stringify(artifact),
  });
  return key;
}

async function deliverIngest(body: unknown) {
  const message = fakeMessage(body);
  await handleQueueBatch({ queue: "wr-ingest", messages: [message] }, env);
  return message;
}

describe("normalize end-to-end (manual fixture adapter)", () => {
  it("creates pending_dedupe signals with provenance, resolves confident hints, counts, and enqueues dedupe", async () => {
    const { p, patel, mainStreet, run } = await fixturePractice();
    const key = await storeArtifact(p.id, "manual", fixtureArtifact);

    const message = await deliverIngest({
      importRunId: run.id,
      rawArtifactKey: key,
      sourceKind: "manual",
      practiceId: p.id,
    });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();

    const rows = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, p.id))
      .orderBy(signals.sourceId);
    expect(rows).toHaveLength(fixtureArtifact.entries.length);
    for (const row of rows) {
      expect(row.pipelineStatus).toBe("pending_dedupe");
      expect(row.importRunId).toBe(run.id);
      expect(row.rawArtifactKey).toBe(key);
      expect(row.sourceKind).toBe("manual");
    }

    // entry-1 carries confident hints: exact names → FKs set, hints null.
    const first = rows.find((row) => row.sourceId === "entry-1");
    expect(first?.providerId).toBe(patel.id);
    expect(first?.locationId).toBe(mainStreet.id);
    expect(first?.providerHint).toBeNull();
    expect(first?.locationHint).toBeNull();
    expect(first?.originalRating).toBe("5.0");
    expect(first?.originalText).toContain("Dr. Patel was wonderful");

    // Counts committed with the rows; no failures.
    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.run.created).toBe(fixtureArtifact.entries.length);
    expect(summary?.errorCount).toBe(0);

    // One dedupe message per signal, none flagged (all new).
    expect(env.DEDUPE_QUEUE.sent).toHaveLength(fixtureArtifact.entries.length);
    for (const sent of env.DEDUPE_QUEUE.sent) {
      expect(sent).toMatchObject({ practiceId: p.id, importRunId: run.id });
      expect(sent).not.toHaveProperty("reason");
    }
  });

  it("re-delivery creates no new rows and enqueues potential-update dedupe messages", async () => {
    const { p, run } = await fixturePractice();
    const key = await storeArtifact(p.id, "manual", fixtureArtifact);
    const body = {
      importRunId: run.id,
      rawArtifactKey: key,
      sourceKind: "manual",
      practiceId: p.id,
    };

    await deliverIngest(body);
    const firstIds = (
      await t.db
        .select({ id: signals.id })
        .from(signals)
        .where(eq(signals.practiceId, p.id))
    )
      .map((row) => row.id)
      .sort();
    env.DEDUPE_QUEUE.sent.length = 0;

    const second = await deliverIngest(body);
    expect(second.ack).toHaveBeenCalledOnce();

    const afterIds = (
      await t.db
        .select({ id: signals.id })
        .from(signals)
        .where(eq(signals.practiceId, p.id))
    )
      .map((row) => row.id)
      .sort();
    expect(afterIds).toEqual(firstIds);

    // Every re-delivered signal routes to dedupe as a potential update,
    // carrying the EXISTING row's id.
    expect(env.DEDUPE_QUEUE.sent).toHaveLength(fixtureArtifact.entries.length);
    for (const sent of env.DEDUPE_QUEUE.sent) {
      expect(sent).toMatchObject({ reason: "conflict_reimport" });
      expect(firstIds).toContain((sent as { signalId: string }).signalId);
    }

    // Conflicts are not "created"; they leave a stats trace instead.
    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.run.created).toBe(fixtureArtifact.entries.length);
    expect(summary?.run.stats).toEqual({
      normalize_conflicts: fixtureArtifact.entries.length,
    });
  });
});

describe("normalize end-to-end (second source kind: csv fixture adapter)", () => {
  it("resolves by sourceKind, stores unmatched hints with basis, and links patients through the PII seam", async () => {
    registerAdapter(csvFixtureAdapter);
    // No providers/locations created: the csv hints must stay hints.
    const p = await practice(t.db);
    const run = await importRun(t.db, {
      practiceId: p.id,
      sourceKind: "csv_import",
    });
    const key = await storeArtifact(p.id, "csv_import", csvFixtureArtifact);

    const message = await deliverIngest({
      importRunId: run.id,
      rawArtifactKey: key,
      sourceKind: "csv_import",
      practiceId: p.id,
    });
    expect(message.ack).toHaveBeenCalledOnce();

    const rows = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, p.id))
      .orderBy(signals.sourceId);
    expect(rows).toHaveLength(csvFixtureArtifact.rows.length);
    expect(rows.every((row) => row.sourceKind === "csv_import")).toBe(true);

    // row-1's provider hint has no matching entity: stored, never guessed.
    const first = rows.find((row) => row.sourceId === "row-1");
    expect(first?.providerId).toBeNull();
    expect(first?.providerHint).toEqual({
      text: "Dr. Patel",
      basis: "source_metadata",
    });

    // The patient hint went through pii.patients/contact_points and linked.
    expect(first?.patientId).not.toBeNull();
    const [patient] = await t.db
      .select()
      .from(patients)
      .where(eq(patients.practiceId, p.id));
    expect(patient?.id).toBe(first?.patientId);
    expect(patient?.displayName).toBe("R. Alvarez");
    const points = await t.db
      .select()
      .from(contactPoints)
      .where(eq(contactPoints.patientId, patient?.id ?? ""));
    expect(points).toHaveLength(1);
    expect(points[0]?.kind).toBe("email");

    // Re-delivery matches the same patient by contact point (no duplicate).
    env.DEDUPE_QUEUE.sent.length = 0;
    await deliverIngest({
      importRunId: run.id,
      rawArtifactKey: key,
      sourceKind: "csv_import",
      practiceId: p.id,
    });
    const allPatients = await t.db
      .select()
      .from(patients)
      .where(eq(patients.practiceId, p.id));
    expect(allPatients).toHaveLength(1);

    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.run.created).toBe(csvFixtureArtifact.rows.length);
  });
});

describe("normalize end-to-end (google reviews adapter, #125)", () => {
  /** The recorded reviews page shared with the fake GBP server (#130). */
  async function loadRecordedPage(): Promise<{ reviews: unknown[] }> {
    return JSON.parse(
      await readFile(
        fileURLToPath(
          new URL(
            "../../../packages/sources/src/google/fixtures/reviews.list.page1.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    );
  }

  it("a poller envelope lands one public signal row per review with google provenance", async () => {
    const p = await practice(t.db);
    const run = await importRun(t.db, {
      practiceId: p.id,
      sourceKind: "google",
    });
    const page = await loadRecordedPage();
    // The artifact exactly as the poller (#123) stores it: the raw page
    // wrapped in the envelope from packages/sources/src/google/schema.ts.
    const key = await storeArtifact(p.id, "google", {
      kind: "gbp.reviews.page",
      envelopeVersion: 1,
      practiceId: p.id,
      googleLocationName: "accounts/1/locations/1",
      fetchedAt: "2026-07-01T00:00:00.000Z",
      page,
    });

    const message = await deliverIngest({
      importRunId: run.id,
      rawArtifactKey: key,
      sourceKind: "google",
      practiceId: p.id,
    });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();

    const rows = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, p.id))
      .orderBy(signals.sourceId);
    expect(rows).toHaveLength(page.reviews.length);
    for (const row of rows) {
      expect(row.sourceKind).toBe("google");
      expect(row.visibility).toBe("public");
      expect(row.pipelineStatus).toBe("pending_dedupe");
      expect(row.rawArtifactKey).toBe(key);
      expect(row.sourceId).toMatch(/^accounts\/1\/locations\/1\/reviews\/\d+$/);
      expect(row.patientId).toBeNull();
      // No location named "accounts/1/locations/1" exists, so the mapping
      // hint is STORED (text + basis), never a guessed FK — the #121
      // mapping lookup resolves it once that lands.
      expect(row.locationId).toBeNull();
      expect(row.locationHint).toEqual({
        text: "accounts/1/locations/1",
        basis: "source_metadata",
      });
    }

    // Star-only review: a rating-only row, not dropped, not empty-stringed.
    const starOnly = rows.find((row) => row.sourceId?.endsWith("/reviews/14"));
    expect(starOnly?.originalText).toBeNull();
    expect(starOnly?.originalRating).toBe("4.0");

    // Edited review: occurred_at is the experience time (createTime), even
    // though the fetched payload carries a later updateTime.
    const edited = rows.find((row) => row.sourceId?.endsWith("/reviews/2"));
    expect(edited?.occurredAt.toISOString()).toBe("2025-07-25T15:13:43.000Z");

    // Replied review: original content lands untouched; the existing-reply
    // state rides the wire metadata (no signals column), never a responses
    // row — Epic #10 imports that state.
    const replied = rows.find((row) => row.sourceId?.endsWith("/reviews/4"));
    expect(replied?.originalRating).toBe("2.0");

    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.run.created).toBe(page.reviews.length);
    expect(summary?.errorCount).toBe(0);
    expect(env.DEDUPE_QUEUE.sent).toHaveLength(page.reviews.length);
  });

  it("a malformed page (unknown starRating) fails the artifact loudly onto the run", async () => {
    const p = await practice(t.db);
    const run = await importRun(t.db, {
      practiceId: p.id,
      sourceKind: "google",
    });
    const key = await storeArtifact(p.id, "google", {
      kind: "gbp.reviews.page",
      envelopeVersion: 1,
      practiceId: p.id,
      googleLocationName: "accounts/1/locations/1",
      fetchedAt: "2026-07-01T00:00:00.000Z",
      page: {
        reviews: [
          {
            name: "accounts/1/locations/1/reviews/1",
            reviewId: "1",
            reviewer: { displayName: "Maria Delgado" },
            starRating: "STAR_RATING_UNSPECIFIED",
            createTime: "2026-05-01T09:00:00.000Z",
            updateTime: "2026-05-01T09:00:00.000Z",
          },
        ],
      },
    });

    const message = await deliverIngest({
      importRunId: run.id,
      rawArtifactKey: key,
      sourceKind: "google",
      practiceId: p.id,
    });
    // Non-retryable: the same bytes will never parse — DLQ, not retry.
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(env.INGEST_DLQ.sent).toHaveLength(1);

    const dlqMessage = fakeMessage(env.INGEST_DLQ.sent[0]);
    await handleQueueBatch(
      { queue: "wr-ingest-dlq", messages: [dlqMessage] },
      env,
    );

    const rows = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, p.id));
    expect(rows).toHaveLength(0);
    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.errorCount).toBe(1);
    expect(summary?.errorSamples[0]?.message).toContain('adapter "google"');
  });
});

describe("normalize failure paths land in the import run (issues #104/#111)", () => {
  it("missing artifact: DLQ forward, then the DLQ consumer records it on the run", async () => {
    const { p, run } = await fixturePractice();
    const body = {
      importRunId: run.id,
      rawArtifactKey: `${p.id}/manual/never-stored.json`,
      sourceKind: "manual",
      practiceId: p.id,
    };

    const message = await deliverIngest(body);
    // Store-before-enqueue violation: forwarded (not retried), then acked.
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(env.INGEST_DLQ.sent).toHaveLength(1);

    // The platform then delivers that envelope on the DLQ; consume it.
    const dlqMessage = fakeMessage(env.INGEST_DLQ.sent[0]);
    await handleQueueBatch(
      { queue: "wr-ingest-dlq", messages: [dlqMessage] },
      env,
    );
    expect(dlqMessage.ack).toHaveBeenCalledOnce();

    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.errorCount).toBe(1);
    expect(summary?.errorSamples[0]).toMatchObject({
      stage: "ingest",
      payloadRef: body.rawArtifactKey,
    });
    expect(summary?.errorSamples[0]?.message).toContain(
      "Raw artifact not found",
    );
    expect(summary?.run.created).toBe(0);
  });

  it("unknown sourceKind: DLQ forward with the failure recorded on the run", async () => {
    const p = await practice(t.db);
    const run = await importRun(t.db, {
      practiceId: p.id,
      sourceKind: "opendental",
    });
    const key = await storeArtifact(p.id, "opendental", { events: [] });
    const body = {
      importRunId: run.id,
      rawArtifactKey: key,
      sourceKind: "opendental",
      practiceId: p.id,
    };

    const message = await deliverIngest(body);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(env.INGEST_DLQ.sent).toHaveLength(1);

    const dlqMessage = fakeMessage(env.INGEST_DLQ.sent[0]);
    await handleQueueBatch(
      { queue: "wr-ingest-dlq", messages: [dlqMessage] },
      env,
    );

    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.errorCount).toBe(1);
    expect(summary?.errorSamples[0]?.message).toContain(
      'no SourceAdapter registered for sourceKind "opendental"',
    );
  });
});
