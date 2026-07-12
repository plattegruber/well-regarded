/**
 * Dedupe stage end-to-end (issue #106): the real dispatcher, the real
 * normalize handler, and the real Postgres-backed `DedupeStore` (pgvector
 * candidate query included) — with embeddings from the deterministic
 * `FakeEmbeddingProvider` (the real bge-m3 provider is issue #71).
 *
 * The acceptance scenario from the issue: the SAME patient review arriving
 * via two sources (a Google-style poll stand-in and a CSV import) lands as
 * TWO signals with a suspected-duplicate link for human review — never
 * silently merged. Plus the exact path: an unchanged re-import is skipped;
 * an edited one becomes a `signal_versions` row and re-enters classify.
 */

import { FakeEmbeddingProvider } from "@wellregarded/ai";
import { resetEnvCache } from "@wellregarded/core";
import { getImportRunSummary, schema } from "@wellregarded/db";
import {
  buildCsvImportBatchArtifact,
  putRawArtifact,
} from "@wellregarded/sources";
import { InMemoryRawArtifactBucket } from "@wellregarded/sources/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { importRun, practice } from "../../../packages/db/test/factories.js";
import { setupTestDb } from "../../../packages/db/test/harness.js";
import { handleQueueBatch, type StageHandlers } from "../src/dispatch";
import { stageHandlers } from "../src/stages";
import { createDedupeStore, dedupeSignal } from "../src/stages/dedupe";
import {
  fakeMessage,
  type IntegrationEnv,
  integrationEnv,
} from "./support/integrationEnv";

const t = setupTestDb();
const { auditLog, signals, signalVersions, suspectedDuplicates } = schema;

const reviewText =
  "Dr. Patel was wonderful with my daughter — she actually looks forward " +
  "to the dentist now and asks when we can go back for the next visit.";
const when = "2026-05-10T10:00:00Z";

let bucket: InMemoryRawArtifactBucket;
let env: IntegrationEnv;
let handlers: StageHandlers;

beforeEach(() => {
  resetEnvCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  bucket = new InMemoryRawArtifactBucket();
  env = integrationEnv(t.databaseName, bucket);
  // Real normalize (wired off env.HYPERDRIVE); dedupe over the REAL store
  // on the harness db with the deterministic fake embedder injected — the
  // production wiring minus #71's Workers AI provider.
  handlers = {
    ...stageHandlers,
    dedupe: (message, env) =>
      dedupeSignal(message, env, {
        store: createDedupeStore(t.db),
        embedder: new FakeEmbeddingProvider(),
      }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function storeArtifact(
  practiceId: string,
  sourceKind: "manual" | "csv_import",
  artifact: unknown,
): Promise<string> {
  const { key } = await putRawArtifact(bucket, {
    practiceId,
    sourceKind,
    content: JSON.stringify(artifact),
  });
  return key;
}

async function deliver(queue: string, body: unknown) {
  const message = fakeMessage(body);
  await handleQueueBatch({ queue, messages: [message] }, env, handlers);
  return message;
}

/** Run one artifact through ingest, then its dedupe messages through dedupe. */
async function ingestAndDedupe(body: {
  importRunId: string;
  rawArtifactKey: string;
  sourceKind: string;
  practiceId: string;
}) {
  const ingest = await deliver("wr-ingest", body);
  expect(ingest.ack).toHaveBeenCalledOnce();
  const dedupeBodies = env.DEDUPE_QUEUE.sent.splice(0);
  const messages = [];
  for (const dedupeBody of dedupeBodies) {
    messages.push(await deliver("wr-dedupe", dedupeBody));
  }
  return { dedupeBodies, messages };
}

describe("acceptance: same review via two sources → linked, never merged", () => {
  it("creates two signals plus one pending_review suspected_duplicates row, and both proceed to classify", async () => {
    const p = await practice(t.db);

    // First arrival: the review through the (fixture) polling source.
    const manualKey = await storeArtifact(p.id, "manual", {
      entries: [{ id: "g-review-1", when, text: reviewText, rating: 5 }],
    });
    const manualRun = await importRun(t.db, {
      practiceId: p.id,
      sourceKind: "manual",
      rawArtifactKeys: [manualKey],
    });
    await ingestAndDedupe({
      importRunId: manualRun.id,
      rawArtifactKey: manualKey,
      sourceKind: "manual",
      practiceId: p.id,
    });

    // Second arrival: the SAME review inside the previous vendor's CSV —
    // one batch envelope exactly as the import Workflow (#135) stores it.
    const csvKey = await storeArtifact(
      p.id,
      "csv_import",
      buildCsvImportBatchArtifact({
        practiceId: p.id,
        draftId: "3b74b0f7-6d7c-4b7e-9f36-1af6a29f2f3a",
        batchIndex: 0,
        firstRowNumber: 1,
        headers: ["Date", "Review", "Rating"],
        mapping: {
          occurredAt: { column: "Date", dateFormat: "ISO" },
          text: { column: "Review" },
          rating: { column: "Rating", ratingScale: 5 },
        },
        rows: [[when, reviewText, "5"]],
      }),
    );
    const csvRun = await importRun(t.db, {
      practiceId: p.id,
      sourceKind: "csv_import",
      rawArtifactKeys: [csvKey],
    });
    const { messages } = await ingestAndDedupe({
      importRunId: csvRun.id,
      rawArtifactKey: csvKey,
      sourceKind: "csv_import",
      practiceId: p.id,
    });
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledOnce();
    }

    // BOTH signals exist and stay fully visible — no merge, no hiding.
    const rows = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, p.id))
      .orderBy(signals.sourceKind);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.sourceKind).sort()).toEqual([
      "csv_import",
      "manual",
    ]);
    for (const row of rows) {
      expect(row.availability).toBe("available");
      expect(row.pipelineStatus).toBe("pending_classify");
      expect(row.embedding).not.toBeNull(); // stored for reuse (req 8)
    }

    // Exactly ONE canonical link, pending human review (Epic #11 reads it).
    const links = await t.db
      .select()
      .from(suspectedDuplicates)
      .where(eq(suspectedDuplicates.practiceId, p.id));
    expect(links).toHaveLength(1);
    expect(links[0]?.status).toBe("pending_review");
    expect(links[0]?.similarity).toBeGreaterThan(0.92);
    const linked = [links[0]?.signalIdA, links[0]?.signalIdB].sort();
    expect(linked).toEqual(rows.map((row) => row.id).sort());

    // The run that detected it carries the count; both signals classified.
    const summary = await getImportRunSummary(t.db, p.id, csvRun.id);
    expect(summary?.run.stats).toMatchObject({ suspected_duplicates: 1 });
    expect(env.CLASSIFY_QUEUE.sent).toHaveLength(2);

    // Redelivery of the same dedupe message cannot double-link (canonical
    // pair unique index) or double-count.
    const csvSignal = rows.find((row) => row.sourceKind === "csv_import");
    await deliver("wr-dedupe", {
      signalId: csvSignal?.id,
      practiceId: p.id,
      importRunId: csvRun.id,
    });
    const linksAfter = await t.db
      .select()
      .from(suspectedDuplicates)
      .where(eq(suspectedDuplicates.practiceId, p.id));
    expect(linksAfter).toHaveLength(1);
    const summaryAfter = await getImportRunSummary(t.db, p.id, csvRun.id);
    expect(summaryAfter?.run.stats).toMatchObject({ suspected_duplicates: 1 });
  });
});

describe("exact path: re-imports of a known source identity", () => {
  beforeEach(() => {
    // The exact path needs no embedder, so this suite runs the REAL wired
    // handler (per-message client over env.HYPERDRIVE) — the production
    // posture until #71 wires the embedding provider. The initial (fuzzy)
    // pass of each new signal skips loudly and still classifies.
    handlers = stageHandlers;
  });

  async function seedOriginal() {
    const p = await practice(t.db);
    const key = await storeArtifact(p.id, "manual", {
      entries: [{ id: "entry-1", when, text: reviewText, rating: 5 }],
    });
    const run = await importRun(t.db, {
      practiceId: p.id,
      sourceKind: "manual",
      rawArtifactKeys: [key],
    });
    await ingestAndDedupe({
      importRunId: run.id,
      rawArtifactKey: key,
      sourceKind: "manual",
      practiceId: p.id,
    });
    env.CLASSIFY_QUEUE.sent.length = 0;
    const [original] = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, p.id));
    if (!original) throw new Error("seed failed");
    return { p, original };
  }

  it("unchanged re-import → skipped incremented, nothing downstream, no versions", async () => {
    const { p, original } = await seedOriginal();

    // The same artifact bytes arrive again in a NEW run (content-addressed
    // key is identical).
    const key = await storeArtifact(p.id, "manual", {
      entries: [{ id: "entry-1", when, text: reviewText, rating: 5 }],
    });
    const rerun = await importRun(t.db, {
      practiceId: p.id,
      sourceKind: "manual",
      rawArtifactKeys: [key],
    });
    const { dedupeBodies, messages } = await ingestAndDedupe({
      importRunId: rerun.id,
      rawArtifactKey: key,
      sourceKind: "manual",
      practiceId: p.id,
    });

    // Normalize flagged the conflict; dedupe resolved it as unchanged.
    expect(dedupeBodies[0]).toMatchObject({
      reason: "conflict_reimport",
      signalId: original.id,
    });
    expect(messages[0]?.ack).toHaveBeenCalledOnce();

    const summary = await getImportRunSummary(t.db, p.id, rerun.id);
    expect(summary?.run.skipped).toBe(1);
    expect(summary?.run.merged).toBe(0);
    expect(summary?.run.created).toBe(0);
    expect(env.CLASSIFY_QUEUE.sent).toHaveLength(0);

    const versions = await t.db
      .select()
      .from(signalVersions)
      .where(eq(signalVersions.signalId, original.id));
    expect(versions).toHaveLength(0);
  });

  it("edited re-import → signal_versions row, pointer moved, merged incremented, classify re-enqueued, audit-logged", async () => {
    const { p, original } = await seedOriginal();

    const editedText = `${reviewText} EDIT: still thrilled a month later.`;
    const key = await storeArtifact(p.id, "manual", {
      entries: [{ id: "entry-1", when, text: editedText, rating: 4 }],
    });
    const editRun = await importRun(t.db, {
      practiceId: p.id,
      sourceKind: "manual",
      rawArtifactKeys: [key],
    });
    const { messages } = await ingestAndDedupe({
      importRunId: editRun.id,
      rawArtifactKey: key,
      sourceKind: "manual",
      practiceId: p.id,
    });
    expect(messages[0]?.ack).toHaveBeenCalledOnce();

    // The update policy: original untouched, version appended, pointer set.
    const [updated] = await t.db
      .select()
      .from(signals)
      .where(eq(signals.id, original.id));
    expect(updated?.originalText).toBe(reviewText);
    expect(updated?.originalRating).toBe("5.0");
    expect(updated?.currentVersionId).not.toBeNull();
    expect(updated?.pipelineStatus).toBe("pending_classify");

    const versions = await t.db
      .select()
      .from(signalVersions)
      .where(eq(signalVersions.signalId, original.id));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      content: editedText,
      rating: "4.0",
    });

    const summary = await getImportRunSummary(t.db, p.id, editRun.id);
    expect(summary?.run.merged).toBe(1);
    expect(summary?.run.skipped).toBe(0);

    // Derivations refresh: the surviving signal re-enters classify.
    expect(env.CLASSIFY_QUEUE.sent).toEqual([
      expect.objectContaining({
        signalId: original.id,
        importRunId: editRun.id,
      }),
    ]);

    // The version event is audit-logged in the same transaction.
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, original.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "signal.version_recorded",
      actorType: "system",
      actorId: "pipeline:dedupe",
    });

    // A crash-redelivery of the SAME edit now compares equal against the
    // current version and lands on the skipped path — no duplicate version.
    env.CLASSIFY_QUEUE.sent.length = 0;
    await deliver("wr-dedupe", {
      signalId: original.id,
      practiceId: p.id,
      importRunId: editRun.id,
      reason: "conflict_reimport",
    });
    const versionsAfter = await t.db
      .select()
      .from(signalVersions)
      .where(eq(signalVersions.signalId, original.id));
    expect(versionsAfter).toHaveLength(1);
    const summaryAfter = await getImportRunSummary(t.db, p.id, editRun.id);
    expect(summaryAfter?.run.merged).toBe(1);
    expect(summaryAfter?.run.skipped).toBe(1);
    expect(env.CLASSIFY_QUEUE.sent).toHaveLength(0);
  });
});
