/**
 * Dedupe stage on a real workerd batch (issue #106): the dispatcher runs
 * against the real Queues runtime and the real Miniflare R2 simulator, with
 * persistence behind an injected in-memory `DedupeStore` and embeddings
 * behind the deterministic `FakeEmbeddingProvider` (no Postgres, no model —
 * the full Postgres+pgvector path runs in test/dedupe.integration.test.ts).
 *
 * The four key scenarios from the issue:
 * 1. exact re-import, unchanged → `skipped`, ack, nothing downstream;
 * 2. exact re-import, edited → version recorded, classify re-enqueued;
 * 3. fuzzy cross-source pair → suspected link recorded, BOTH retained,
 *    classify still enqueued (no silent merges);
 * 4. clean new signal → straight to classify, no side rows.
 */

import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from "cloudflare:test";
import { FakeEmbeddingProvider } from "@wellregarded/ai";
import { DLQ_FORWARD_KIND } from "@wellregarded/core";
import type {
  DuplicateCandidate,
  SignalWithCurrentContent,
  SuspectedDuplicateLink,
} from "@wellregarded/db";
import {
  buildCsvImportBatchArtifact,
  csvRowSourceId,
  putRawArtifact,
} from "@wellregarded/sources";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleQueueBatch, type StageHandlers } from "../src/dispatch";
import { stageHandlers } from "../src/stages";
import {
  type DedupeDeps,
  type DedupeStore,
  dedupeSignal,
  type IncomingVersion,
} from "../src/stages/dedupe";

const signalId = "8a9c1a52-6a54-4d43-9c39-9d5df2bb0e1a";
const practiceId = "3f2b6a1e-90cd-4f5e-8a2f-1b0f4a7c9d21";
const importRunId = "b1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const otherSignalId = "c0ffee00-aaaa-4bbb-8ccc-123456789abc";
const requestId = "5e0f7ad2-3a9f-4a56-8f18-1b2c3d4e5f60";

const timestamp = new Date("2026-07-10T12:00:00Z");

const reviewText =
  "Dr. Patel was wonderful with my daughter — she actually looks forward " +
  "to the dentist now and asks when we can go back.";

/** A full `signals` row shape, as `getSignalWithCurrentContent` returns it. */
function signalRecord(
  overrides: Partial<SignalWithCurrentContent["signal"]> = {},
): SignalWithCurrentContent {
  const signal: SignalWithCurrentContent["signal"] = {
    id: signalId,
    practiceId,
    patientId: null,
    locationId: null,
    providerId: null,
    sourceKind: "csv_import",
    sourceId: "csv-row-1-source-id",
    sourceUrl: null,
    occurredAt: new Date("2026-03-02T14:30:00Z"),
    rawArtifactKey: null,
    importRunId,
    providerHint: null,
    locationHint: null,
    originalText: reviewText,
    originalRating: "5.0",
    currentVersionId: null,
    embedding: null,
    // Postgres-owned stored generated column (issue #88) — never read here.
    tsv: null,
    pipelineStatus: "pending_dedupe",
    visibility: "private",
    availability: "available",
    retentionState: "active",
    classificationDeferredAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
  return {
    signal,
    currentText: signal.originalText,
    currentRating: signal.originalRating,
  };
}

/** Recording in-memory DedupeStore. */
function makeStore(options: {
  record: SignalWithCurrentContent | undefined;
  artifactKeys?: string[];
  candidates?: DuplicateCandidate[];
}) {
  const calls = {
    skipped: 0,
    edited: [] as { incoming: IncomingVersion; embedding: number[] | null }[],
    embeddingsSaved: [] as { signalId: string; embedding: number[] }[],
    suspected: [] as SuspectedDuplicateLink[][],
    markedReady: [] as string[],
  };
  const store: DedupeStore = {
    getSignal: async () => options.record,
    getImportRunArtifactKeys: async () => options.artifactKeys ?? [],
    recordUnchangedReimport: async () => {
      calls.skipped += 1;
    },
    recordEditedReimport: async (_message, incoming, embedding) => {
      calls.edited.push({ incoming, embedding });
    },
    saveEmbedding: async (id, embedding) => {
      calls.embeddingsSaved.push({ signalId: id, embedding });
    },
    findCandidates: async () => options.candidates ?? [],
    recordSuspectedDuplicates: async (_message, links) => {
      calls.suspected.push(links);
      return links.length;
    },
    markReadyForClassify: async (id) => {
      calls.markedReady.push(id);
    },
  };
  return { store, calls };
}

function handlersWith(deps: DedupeDeps): StageHandlers {
  return {
    ...stageHandlers,
    dedupe: (message, env) => dedupeSignal(message, env, deps),
  };
}

async function deliver(
  body: unknown,
  deps: DedupeDeps,
  envOverrides: object = {},
) {
  const batch = createMessageBatch("wr-dedupe", [
    { id: "dedupe-1", timestamp, attempts: 1, body },
  ]);
  const ctx = createExecutionContext();
  await handleQueueBatch(
    batch,
    { ...env, ...envOverrides },
    handlersWith(deps),
  );
  return getQueueResult(batch, ctx);
}

const baseMessage = { signalId, practiceId, importRunId, requestId };

// One-row CSV batch envelope, exactly as the import Workflow (#135)
// stores it — same draft + row number means the same deterministic
// sourceId, which is what makes a re-stored batch a re-import of a KNOWN
// source identity (the exact path's subject).
const DRAFT_ID = "5c85c1f8-7e8d-4d65-8ea1-0b6c3a5d9f45";

async function storeCsvBatch(text: string, rating: string): Promise<string> {
  const { key } = await putRawArtifact(env.RAW_ARTIFACTS, {
    practiceId,
    sourceKind: "csv_import",
    content: JSON.stringify(
      buildCsvImportBatchArtifact({
        practiceId,
        draftId: DRAFT_ID,
        batchIndex: 0,
        firstRowNumber: 1,
        headers: ["Date", "Review", "Rating"],
        mapping: {
          occurredAt: { column: "Date", dateFormat: "ISO" },
          text: { column: "Review" },
          rating: { column: "Rating", ratingScale: 5 },
        },
        rows: [["2026-03-02T14:30:00Z", text, rating]],
      }),
    ),
  });
  return key;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("dedupe exact path (reason: conflict_reimport)", () => {
  it("unchanged re-import → skipped, acked, nothing downstream", async () => {
    const key = await storeCsvBatch(reviewText, "5");
    const { store, calls } = makeStore({
      record: signalRecord({ sourceId: await csvRowSourceId(DRAFT_ID, 1) }),
      artifactKeys: [key],
    });
    const classifySend = vi.fn().mockResolvedValue(undefined);

    const result = await deliver(
      { ...baseMessage, reason: "conflict_reimport" },
      { store, embedder: new FakeEmbeddingProvider() },
      { CLASSIFY_QUEUE: { send: classifySend } },
    );

    expect(result.explicitAcks).toEqual(["dedupe-1"]);
    expect(result.retryMessages).toEqual([]);
    expect(calls.skipped).toBe(1);
    expect(calls.edited).toEqual([]);
    expect(calls.suspected).toEqual([]);
    expect(calls.markedReady).toEqual([]);
    expect(classifySend).not.toHaveBeenCalled();
  });

  it("edited re-import → version recorded with re-embedded content, classify re-enqueued, merged path", async () => {
    const editedText = `${reviewText} EDIT: still thrilled a month later.`;
    const key = await storeCsvBatch(editedText, "5");
    const { store, calls } = makeStore({
      record: signalRecord({ sourceId: await csvRowSourceId(DRAFT_ID, 1) }),
      artifactKeys: [key],
    });
    const classifySend = vi.fn().mockResolvedValue(undefined);
    const embedder = new FakeEmbeddingProvider();

    const result = await deliver(
      { ...baseMessage, reason: "conflict_reimport" },
      { store, embedder },
      { CLASSIFY_QUEUE: { send: classifySend } },
    );

    expect(result.explicitAcks).toEqual(["dedupe-1"]);
    expect(calls.skipped).toBe(0);
    expect(calls.edited).toHaveLength(1);
    expect(calls.edited[0]?.incoming).toMatchObject({
      text: editedText,
      rating: "5.0",
    });
    // The NEW text was re-embedded so the stored vector stays truthful.
    expect(calls.edited[0]?.embedding).toEqual(
      await embedder.embedText(editedText),
    );
    // The surviving signal re-enters the spine: derivations must refresh.
    expect(calls.markedReady).toEqual([signalId]);
    expect(classifySend).toHaveBeenCalledExactlyOnceWith({
      signalId,
      practiceId,
      importRunId,
      requestId,
    });
  });

  it("a rating-only edit (same text, changed rating) is also a new version", async () => {
    const key = await storeCsvBatch(reviewText, "4");
    const { store, calls } = makeStore({
      record: signalRecord({ sourceId: await csvRowSourceId(DRAFT_ID, 1) }),
      artifactKeys: [key],
    });
    const classifySend = vi.fn().mockResolvedValue(undefined);

    await deliver(
      { ...baseMessage, reason: "conflict_reimport" },
      { store, embedder: new FakeEmbeddingProvider() },
      { CLASSIFY_QUEUE: { send: classifySend } },
    );

    expect(calls.edited).toHaveLength(1);
    expect(calls.edited[0]?.incoming.rating).toBe("4.0");
    // The CSV adapter carries no source update time — version rows get
    // null until a source reports one.
    expect(calls.edited[0]?.incoming.sourceUpdatedAt).toBeNull();
    expect(classifySend).toHaveBeenCalledOnce();
  });

  it("an edited google review threads updateTime into the version's sourceUpdatedAt (#125)", async () => {
    const reviewName = "accounts/1/locations/1/reviews/9";
    const createTime = "2026-03-02T14:30:00.000Z";
    const editedText = `${reviewText} Edit: still thrilled a month later.`;
    // The re-imported artifact, exactly as the poller (#123) stores it: the
    // envelope around the fetched reviews page, with updateTime > createTime.
    const { key } = await putRawArtifact(env.RAW_ARTIFACTS, {
      practiceId,
      sourceKind: "google",
      content: JSON.stringify({
        kind: "gbp.reviews.page",
        envelopeVersion: 1,
        practiceId,
        googleLocationName: "accounts/1/locations/1",
        fetchedAt: "2026-07-01T00:00:00.000Z",
        page: {
          reviews: [
            {
              name: reviewName,
              reviewId: "9",
              reviewer: { displayName: "Brad Huang" },
              starRating: "FIVE",
              comment: editedText,
              createTime,
              updateTime: "2026-04-01T09:00:00.000Z",
            },
          ],
          totalReviewCount: 1,
        },
      }),
    });
    const { store, calls } = makeStore({
      record: signalRecord({ sourceKind: "google", sourceId: reviewName }),
      artifactKeys: [key],
    });
    const classifySend = vi.fn().mockResolvedValue(undefined);

    await deliver(
      { ...baseMessage, reason: "conflict_reimport" },
      { store, embedder: new FakeEmbeddingProvider() },
      { CLASSIFY_QUEUE: { send: classifySend } },
    );

    expect(calls.edited).toHaveLength(1);
    expect(calls.edited[0]?.incoming).toMatchObject({
      text: editedText,
      rating: "5.0",
      // occurredAt stays the experience time (createTime)…
      occurredAt: new Date(createTime),
      // …while the source-reported edit time rides through to the version
      // row's source_updated_at (#106's version chain).
      sourceUpdatedAt: new Date("2026-04-01T09:00:00.000Z"),
    });
    expect(classifySend).toHaveBeenCalledOnce();
  });

  it("no matching entry in the run's artifacts → DLQ forward (contract violation), acked", async () => {
    const key = await storeCsvBatch(reviewText, "5");
    const { store } = makeStore({
      // A sourceId no row of the stored batch can produce.
      record: signalRecord({ sourceId: await csvRowSourceId(DRAFT_ID, 99) }),
      artifactKeys: [key],
    });
    const dlqSend = vi.fn().mockResolvedValue(undefined);

    const result = await deliver(
      { ...baseMessage, reason: "conflict_reimport" },
      { store, embedder: new FakeEmbeddingProvider() },
      { DEDUPE_DLQ: { send: dlqSend } },
    );

    expect(result.explicitAcks).toEqual(["dedupe-1"]);
    expect(dlqSend).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: DLQ_FORWARD_KIND,
        stage: "dedupe",
        reason: "non_retryable",
        error: expect.stringContaining("no matching entry"),
      }),
    );
  });
});

describe("dedupe fuzzy path (new signals)", () => {
  it("cross-source near-duplicate → suspected link recorded AND the signal still proceeds to classify", async () => {
    const candidate: DuplicateCandidate = {
      id: otherSignalId,
      similarity: 0.97,
      rating: "5.0",
      sourceKind: "csv_import",
      sourceId: "row-9",
    };
    const { store, calls } = makeStore({
      record: signalRecord(),
      candidates: [candidate],
    });
    const classifySend = vi.fn().mockResolvedValue(undefined);

    const result = await deliver(
      baseMessage,
      { store, embedder: new FakeEmbeddingProvider() },
      { CLASSIFY_QUEUE: { send: classifySend } },
    );

    expect(result.explicitAcks).toEqual(["dedupe-1"]);
    // The link exists for human review…
    expect(calls.suspected).toEqual([
      [
        {
          practiceId,
          signalIdX: signalId,
          signalIdY: otherSignalId,
          similarity: 0.97,
        },
      ],
    ]);
    // …and the new signal was NOT merged, hidden, or dropped: it advances.
    expect(calls.markedReady).toEqual([signalId]);
    expect(classifySend).toHaveBeenCalledExactlyOnceWith({
      signalId,
      practiceId,
      importRunId,
      requestId,
    });
    // Requirement 8: the computed embedding was stored for reuse.
    expect(calls.embeddingsSaved).toHaveLength(1);
    expect(calls.embeddingsSaved[0]?.signalId).toBe(signalId);
  });

  it("candidates failing the predicates (rating mismatch / same identity / below threshold) create no links", async () => {
    const { store, calls } = makeStore({
      record: signalRecord(),
      candidates: [
        // below threshold
        {
          id: otherSignalId,
          similarity: 0.9,
          rating: "5.0",
          sourceKind: "csv_import",
          sourceId: "row-1",
        },
        // rating mismatch
        {
          id: otherSignalId,
          similarity: 0.99,
          rating: "4.0",
          sourceKind: "csv_import",
          sourceId: "row-2",
        },
        // same source identity — the exact path's job, never a fuzzy link
        {
          id: otherSignalId,
          similarity: 0.99,
          rating: "5.0",
          sourceKind: "csv_import",
          sourceId: "csv-row-1-source-id",
        },
      ],
    });
    const classifySend = vi.fn().mockResolvedValue(undefined);

    await deliver(
      baseMessage,
      { store, embedder: new FakeEmbeddingProvider() },
      { CLASSIFY_QUEUE: { send: classifySend } },
    );

    expect(calls.suspected).toEqual([]);
    expect(classifySend).toHaveBeenCalledOnce();
  });

  it("clean new signal (no candidates) → straight to classify, no side effects", async () => {
    const { store, calls } = makeStore({ record: signalRecord() });
    const classifySend = vi.fn().mockResolvedValue(undefined);

    const result = await deliver(
      baseMessage,
      { store, embedder: new FakeEmbeddingProvider() },
      { CLASSIFY_QUEUE: { send: classifySend } },
    );

    expect(result.explicitAcks).toEqual(["dedupe-1"]);
    expect(calls.skipped).toBe(0);
    expect(calls.edited).toEqual([]);
    expect(calls.suspected).toEqual([]);
    expect(classifySend).toHaveBeenCalledOnce();
  });

  it("reuses a stored embedding instead of re-embedding", async () => {
    const stored = Array.from({ length: 1024 }, () => 0);
    stored[0] = 1;
    const { store, calls } = makeStore({
      record: signalRecord({ embedding: stored }),
    });
    const classifySend = vi.fn().mockResolvedValue(undefined);
    const embedder = new FakeEmbeddingProvider();
    const embedSpy = vi.spyOn(embedder, "embedText");

    await deliver(
      baseMessage,
      { store, embedder },
      { CLASSIFY_QUEUE: { send: classifySend } },
    );

    expect(embedSpy).not.toHaveBeenCalled();
    expect(calls.embeddingsSaved).toEqual([]);
    expect(classifySend).toHaveBeenCalledOnce();
  });

  it("no embedder wired (pre-#71 posture) → fuzzy path skipped loudly, signal still classifies", async () => {
    // The structured logger writes ALL levels to console.log (one JSON
    // line per record — see packages/core/src/log/logger.ts).
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { store, calls } = makeStore({
      record: signalRecord(),
      candidates: [
        {
          id: otherSignalId,
          similarity: 0.99,
          rating: "5.0",
          sourceKind: "csv_import",
          sourceId: "row-9",
        },
      ],
    });
    const classifySend = vi.fn().mockResolvedValue(undefined);

    await deliver(
      baseMessage,
      { store },
      {
        CLASSIFY_QUEUE: { send: classifySend },
      },
    );

    expect(calls.suspected).toEqual([]);
    expect(classifySend).toHaveBeenCalledOnce();
    const warned = logSpy.mock.calls.map((call) => String(call[0]));
    expect(
      warned.some((line) =>
        line.includes("pipeline.dedupe.fuzzy_skipped_no_embedder"),
      ),
    ).toBe(true);
  });

  it("text-less signal → fuzzy path skipped, still classifies (rating-only)", async () => {
    const record = signalRecord({ originalText: null });
    record.currentText = null;
    const { store, calls } = makeStore({ record });
    const classifySend = vi.fn().mockResolvedValue(undefined);
    const embedder = new FakeEmbeddingProvider();
    const embedSpy = vi.spyOn(embedder, "embedText");

    await deliver(
      baseMessage,
      { store, embedder },
      {
        CLASSIFY_QUEUE: { send: classifySend },
      },
    );

    expect(embedSpy).not.toHaveBeenCalled();
    expect(calls.suspected).toEqual([]);
    expect(classifySend).toHaveBeenCalledOnce();
  });

  it("missing signal row → DLQ forward, acked", async () => {
    const { store } = makeStore({ record: undefined });
    const dlqSend = vi.fn().mockResolvedValue(undefined);

    const result = await deliver(
      baseMessage,
      { store, embedder: new FakeEmbeddingProvider() },
      { DEDUPE_DLQ: { send: dlqSend } },
    );

    expect(result.explicitAcks).toEqual(["dedupe-1"]);
    expect(dlqSend).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: DLQ_FORWARD_KIND,
        stage: "dedupe",
        reason: "non_retryable",
        error: expect.stringContaining("does not exist"),
      }),
    );
  });
});
