/**
 * Worker-level queue-consumer tests (issue #98): unlike the fake-driven unit
 * tests in src/dispatch.test.ts, these run the real `queue()` export inside
 * workerd via @cloudflare/vitest-pool-workers, with `createMessageBatch` /
 * `getQueueResult` reporting the ack/retry state the Queues runtime actually
 * recorded — the closest a test gets to production delivery semantics.
 */

import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from "cloudflare:test";
import {
  EXCERPTS_PROMPT_NAME,
  FakeAiProvider,
  FakeEmbeddingProvider,
  JUDGMENTS_PROMPT_NAME,
  type JudgmentDerivation,
  type PlannedExcerpt,
} from "@wellregarded/ai";
import {
  buildDlqForwardEnvelope,
  DLQ_FORWARD_KIND,
  RetryableError,
} from "@wellregarded/core";
import {
  buildCsvImportBatchArtifact,
  type NormalizedSignal,
  putRawArtifact,
} from "@wellregarded/sources";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleQueueBatch, type StageHandlers } from "../src/dispatch";
import { stageHandlers } from "../src/stages";
import {
  type ClassifyDeps,
  type ClassifyStore,
  classifySignal,
  type ExcerptEmbeddingUpdate,
} from "../src/stages/classify";
import {
  type NormalizeStore,
  normalizeArtifact,
} from "../src/stages/normalize";
import {
  auditOnlyProofSink,
  auditOnlyRecoverySink,
  defaultRoutingConfig,
  type RouteDeps,
  type RouteStore,
  type RoutingDerivations,
  type RoutingOutcome,
  routeSignal,
  type SignalForRouting,
} from "../src/stages/route";
import worker from "../src/worker";

const uuid = "8a9c1a52-6a54-4d43-9c39-9d5df2bb0e1a";
const otherUuid = "3f2b6a1e-90cd-4f5e-8a2f-1b0f4a7c9d21";
const requestId = "5e0f7ad2-3a9f-4a56-8f18-1b2c3d4e5f60";

const validIngest = {
  importRunId: uuid,
  rawArtifactKey: "raw/google/sha256-abc123",
  sourceKind: "google",
  practiceId: otherUuid,
  requestId,
};

const validSignalStage = {
  signalId: uuid,
  practiceId: otherUuid,
  importRunId: uuid,
  requestId,
};

const timestamp = new Date("2026-07-10T12:00:00Z");

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("worker.queue", () => {
  it("logs from the workerd consumer carry the message's requestId (issue #64)", async () => {
    // Every stage handler does real work now (#67/#104/#106/#108), so the
    // last stub is gone. Run the real dedupe handler with HYPERDRIVE
    // unbound (never the dead-end socket — opening it crashes workerd):
    // its missing-binding RetryableError is thrown before any I/O, and the
    // resulting retry log must carry the message's propagated requestId.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const batch = createMessageBatch("wr-dedupe", [
      { id: "trace-1", timestamp, attempts: 1, body: validSignalStage },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, { ...env, HYPERDRIVE: undefined }, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.retryMessages).toEqual([{ msgId: "trace-1" }]);
    const records = logSpy.mock.calls.map((call) =>
      JSON.parse(String(call[0])),
    );
    const retryLine = records.find(
      (record) => record.msg === "pipeline.dispatch.retry",
    );
    expect(retryLine).toMatchObject({
      worker: "pipeline",
      stage: "dedupe",
      requestId,
    });
  });

  it("acks a zod-invalid message and forwards it to the stage DLQ producer", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const batch = createMessageBatch("wr-ingest", [
      { id: "bad-1", timestamp, attempts: 1, body: { importRunId: 42 } },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, { ...env, INGEST_DLQ: { send } }, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: DLQ_FORWARD_KIND,
        stage: "ingest",
        reason: "malformed",
        body: { importRunId: 42 },
      }),
    );
    expect(result.explicitAcks).toEqual(["bad-1"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("marks a message for retry when its handler throws RetryableError", async () => {
    // The committed stage stubs never throw, so drive the dispatcher with an
    // injected throwing handler — against the same real runtime batch.
    const handlers: StageHandlers = {
      ingest: async () => {},
      dedupe: async () => {
        throw new RetryableError("transient");
      },
      classify: async () => {},
      route: async () => {},
    };
    const batch = createMessageBatch("wr-dedupe", [
      { id: "retry-1", timestamp, attempts: 1, body: validSignalStage },
    ]);
    const ctx = createExecutionContext();
    await handleQueueBatch(batch, env, handlers);
    const result = await getQueueResult(batch, ctx);
    expect(result.retryMessages).toEqual([{ msgId: "retry-1" }]);
    expect(result.explicitAcks).toEqual([]);
  });

  it("persists and acks a DLQ message via the log-only fallback", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const envelope = buildDlqForwardEnvelope({
      stage: "classify",
      reason: "non_retryable",
      error: "signal row was purged",
      body: validSignalStage,
    });
    const batch = createMessageBatch("wr-classify-dlq", [
      { id: "dlq-1", timestamp, attempts: 1, body: envelope },
    ]);
    const ctx = createExecutionContext();
    // HYPERDRIVE deliberately unbound: the unit pool must not reach for
    // Postgres, so this asserts the DLQ consumer's log-only fallback; the
    // import_runs write is covered by test/poisonMessage.integration.test.ts.
    await worker.queue(batch, { ...env, HYPERDRIVE: undefined }, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["dlq-1"]);
    expect(result.retryMessages).toEqual([]);
    const logged = logSpy.mock.calls.map((call) => String(call[0]));
    expect(
      logged.some(
        (line) =>
          line.includes("pipeline.failure") &&
          line.includes("non_retryable") &&
          line.includes("signal row was purged"),
      ),
    ).toBe(true);
  });
});

describe("normalize stage on a real workerd batch (issue #104)", () => {
  // The real `normalize` handler wires R2 + Postgres off env; here the
  // dispatcher runs against the real Queues runtime and the real Miniflare
  // R2 simulator, with persistence behind an injected in-memory
  // NormalizeStore (no Postgres inside the test pool — the full
  // Postgres-backed path runs in test/normalize.integration.test.ts).

  function handlersWithStore(store: NormalizeStore): StageHandlers {
    return {
      ...stageHandlers,
      ingest: (message, env) => normalizeArtifact(message, env, { store }),
    };
  }

  it("acks after persisting a batch artifact's signals and enqueueing dedupe messages (conflicts flagged)", async () => {
    // A three-row CSV batch envelope, exactly as the import Workflow
    // (#135) stores it — a registered adapter that yields several signals
    // per artifact, so the conflict/created split below is observable.
    const batchArtifact = buildCsvImportBatchArtifact({
      practiceId: otherUuid,
      draftId: uuid,
      batchIndex: 0,
      firstRowNumber: 1,
      headers: ["Date", "Review"],
      mapping: {
        occurredAt: { column: "Date", dateFormat: "ISO" },
        text: { column: "Review" },
      },
      rows: [
        ["2026-04-01T10:00:00Z", "The hygiene team here is so careful."],
        ["2026-04-02T11:00:00Z", "Front desk sorted my insurance out."],
        ["2026-04-03T12:00:00Z", "Dr. Patel explained every step."],
      ],
    });
    // Store-before-enqueue, for real: the artifact goes into the
    // Miniflare R2 simulator first, and the message carries the key.
    const { key } = await putRawArtifact(env.RAW_ARTIFACTS, {
      practiceId: otherUuid,
      sourceKind: "csv_import",
      content: JSON.stringify(batchArtifact),
    });
    const persisted: NormalizedSignal[][] = [];
    const store: NormalizeStore = {
      persistSignals: async (_message, signals) => {
        persisted.push(signals);
        // One pre-existing row (a re-imported entry) plus new rows.
        return signals.map((signal, index) => ({
          signalId: `${index}${uuid.slice(1)}`,
          sourceId: signal.sourceId,
          outcome: index === 0 ? ("conflict" as const) : ("created" as const),
        }));
      },
    };
    const dedupeSend = vi.fn().mockResolvedValue(undefined);
    const message = {
      importRunId: uuid,
      rawArtifactKey: key,
      sourceKind: "csv_import",
      practiceId: otherUuid,
    };

    const batch = createMessageBatch("wr-ingest", [
      { id: "ingest-1", timestamp, attempts: 1, body: message },
    ]);
    const ctx = createExecutionContext();
    await handleQueueBatch(
      batch,
      { ...env, DEDUPE_QUEUE: { send: dedupeSend } },
      handlersWithStore(store),
    );
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(["ingest-1"]);
    expect(result.retryMessages).toEqual([]);
    // The adapter saw the artifact's three rows…
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toHaveLength(batchArtifact.rows.length);
    // …and every outcome became a dedupe message, the conflict flagged as a
    // potential update for #106.
    expect(dedupeSend).toHaveBeenCalledTimes(batchArtifact.rows.length);
    expect(dedupeSend.mock.calls[0]?.[0]).toMatchObject({
      practiceId: otherUuid,
      importRunId: uuid,
      reason: "conflict_reimport",
    });
    expect(dedupeSend.mock.calls[1]?.[0]).not.toHaveProperty("reason");
  });

  it("delivers a google review's existingReply through the wire contract to the store (#214)", async () => {
    // A one-review page with a pre-existing owner reply, wrapped exactly
    // as the poller (#123) stores it. The store seam is where #214's
    // persistence hooks in — this pins that the metadata actually arrives
    // there through the real queue + R2 path (the Postgres write itself is
    // covered in test/normalize.integration.test.ts).
    const envelope = {
      kind: "gbp.reviews.page",
      envelopeVersion: 1,
      practiceId: otherUuid,
      googleLocationName: "accounts/1/locations/1",
      fetchedAt: "2026-07-01T00:00:00.000Z",
      page: {
        reviews: [
          {
            name: "accounts/1/locations/1/reviews/replied-1",
            reviewer: { displayName: "Maria Delgado" },
            starRating: "TWO",
            comment: "Billing was confusing.",
            createTime: "2026-06-11T05:35:36.000Z",
            updateTime: "2026-06-12T05:35:36.000Z",
            reviewReply: {
              comment: "We apologize — our manager has reached out.",
              updateTime: "2026-06-12T05:35:36.000Z",
              reviewReplyState: "APPROVED",
            },
          },
        ],
      },
    };
    const { key } = await putRawArtifact(env.RAW_ARTIFACTS, {
      practiceId: otherUuid,
      sourceKind: "google",
      content: JSON.stringify(envelope),
    });
    const persisted: NormalizedSignal[][] = [];
    const store: NormalizeStore = {
      persistSignals: async (_message, signals) => {
        persisted.push(signals);
        return signals.map((signal) => ({
          signalId: uuid,
          sourceId: signal.sourceId,
          outcome: "created" as const,
        }));
      },
    };

    const batch = createMessageBatch("wr-ingest", [
      {
        id: "ingest-replied",
        timestamp,
        attempts: 1,
        body: {
          importRunId: uuid,
          rawArtifactKey: key,
          sourceKind: "google",
          practiceId: otherUuid,
        },
      },
    ]);
    const ctx = createExecutionContext();
    await handleQueueBatch(
      batch,
      { ...env, DEDUPE_QUEUE: { send: vi.fn().mockResolvedValue(undefined) } },
      handlersWithStore(store),
    );
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(["ingest-replied"]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.[0]?.sourceMetadata?.existingReply).toEqual({
      comment: "We apologize — our manager has reached out.",
      updateTime: "2026-06-12T05:35:36.000Z",
      state: "APPROVED",
    });
  });

  it("forwards a missing artifact to the ingest DLQ and acks (store-before-enqueue violation)", async () => {
    const dlqSend = vi.fn().mockResolvedValue(undefined);
    const batch = createMessageBatch("wr-ingest", [
      {
        id: "ingest-2",
        timestamp,
        attempts: 1,
        body: { ...validIngest, sourceKind: "manual" },
      },
    ]);
    const ctx = createExecutionContext();
    // Real stage handlers: the artifact miss throws before Postgres is
    // ever touched, so the wired handler is safe to run in the pool.
    await worker.queue(batch, { ...env, INGEST_DLQ: { send: dlqSend } }, ctx);
    const result = await getQueueResult(batch, ctx);

    expect(dlqSend).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: DLQ_FORWARD_KIND,
        stage: "ingest",
        reason: "non_retryable",
        error: expect.stringContaining("Raw artifact not found"),
      }),
    );
    expect(result.explicitAcks).toEqual(["ingest-2"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("forwards an unknown sourceKind to the ingest DLQ and acks", async () => {
    // Artifact exists; what's missing is an adapter for its kind
    // (opendental has no adapter yet — google gained one in #125).
    const { key } = await putRawArtifact(env.RAW_ARTIFACTS, {
      practiceId: otherUuid,
      sourceKind: "opendental",
      content: JSON.stringify({ some: "page" }),
    });
    const dlqSend = vi.fn().mockResolvedValue(undefined);
    const batch = createMessageBatch("wr-ingest", [
      {
        id: "ingest-3",
        timestamp,
        attempts: 1,
        body: { ...validIngest, rawArtifactKey: key, sourceKind: "opendental" },
      },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, { ...env, INGEST_DLQ: { send: dlqSend } }, ctx);
    const result = await getQueueResult(batch, ctx);

    expect(dlqSend).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: DLQ_FORWARD_KIND,
        stage: "ingest",
        reason: "non_retryable",
        error: expect.stringContaining(
          'no SourceAdapter registered for sourceKind "opendental"',
        ),
      }),
    );
    expect(result.explicitAcks).toEqual(["ingest-3"]);
  });
});

describe("classify stage on a real workerd batch (issue #67)", () => {
  // The real `classify` handler wires Postgres + Anthropic off env; here the
  // dispatcher runs against the real Queues runtime with those two seams
  // injected (FakeAiProvider + in-memory store), so the assertions cover the
  // actual ack/retry outcomes the platform records.
  const classifyFixture = {
    sentiment: {
      value: "negative",
      confidence: 0.95,
      rationale: "Angry about ongoing pain after an extraction.",
    },
    urgency: {
      value: "critical",
      confidence: 0.85,
      rationale: "Acute post-procedure pain happening now.",
    },
    response_risk: {
      value: "high",
      confidence: 0.8,
      rationale: "Names a procedure; a reply risks confirming care.",
    },
    publication_suitability: {
      value: "unsuitable",
      confidence: 0.9,
      rationale: "Health details the author may regret sharing.",
    },
  };

  function makeStore(hasSignal: boolean, originalText?: string) {
    const inserted: (readonly JudgmentDerivation[])[] = [];
    const insertedExcerpts: (readonly PlannedExcerpt[])[] = [];
    const embeddingUpdates: ExcerptEmbeddingUpdate[] = [];
    const store: ClassifyStore = {
      getSignal: async () =>
        hasSignal
          ? {
              originalText:
                originalText ??
                // 13 words: the excerpt pass short-circuits to one
                // whole-text excerpt with no extraction model call.
                "Still in severe pain three days after my extraction and nobody calls back.",
              originalRating: "1.0",
              retentionState: "active" as const,
              classificationDeferredAt: null,
            }
          : undefined,
      hasJudgments: async () => false,
      insertJudgments: async (_message, rows) => {
        inserted.push(rows);
      },
      hasExcerpts: async () => false,
      insertExcerpts: async (_message, excerpts) => {
        insertedExcerpts.push(excerpts);
        return excerpts.map((excerpt, index) => ({
          id: `excerpt-${index}`,
          text: excerpt.text,
        }));
      },
      setExcerptEmbeddings: async (updates) => {
        embeddingUpdates.push(...updates);
      },
      markClassificationDeferred: async () => {},
      clearClassificationDeferred: async () => {},
    };
    return { store, inserted, insertedExcerpts, embeddingUpdates };
  }

  function handlersWith(deps: ClassifyDeps): StageHandlers {
    return {
      ...stageHandlers,
      classify: (message, env) => classifySignal(message, env, deps),
    };
  }

  it("acks after writing four derivations and enqueueing the route message", async () => {
    const provider = new FakeAiProvider({
      [JUDGMENTS_PROMPT_NAME]: [classifyFixture],
    });
    const { store, inserted } = makeStore(true);
    const routeSend = vi.fn().mockResolvedValue(undefined);

    const batch = createMessageBatch("wr-classify", [
      { id: "classify-1", timestamp, attempts: 1, body: validSignalStage },
    ]);
    const ctx = createExecutionContext();
    await handleQueueBatch(
      batch,
      { ...env, ROUTE_QUEUE: { send: routeSend } },
      handlersWith({
        store,
        provider,
        pipelineModel: "claude-haiku-4-5-20251001",
      }),
    );
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(["classify-1"]);
    expect(result.retryMessages).toEqual([]);
    expect(provider.calls).toHaveLength(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.map((row) => row.dimension)).toEqual([
      "sentiment",
      "urgency",
      "response_risk",
      "publication_suitability",
    ]);
    expect(routeSend).toHaveBeenCalledExactlyOnceWith(validSignalStage);
  });

  it("acks after the second pass writes excerpts and inline embeddings (issues #69/#71)", async () => {
    const multiTopic =
      "Dr. Patel was gentle and explained every step of my root canal. " +
      "The billing office quoted one price and charged me another. " +
      "The waiting room was spotless and the coffee was free.";
    const provider = new FakeAiProvider({
      [JUDGMENTS_PROMPT_NAME]: [classifyFixture],
      [EXCERPTS_PROMPT_NAME]: [
        {
          excerpts: [
            {
              text: "Dr. Patel was gentle and explained every step of my root canal.",
              topic_hint: "provider care",
            },
            {
              text: "The billing office quoted one price and charged me another.",
              topic_hint: "billing",
            },
          ],
        },
      ],
    });
    const embedder = new FakeEmbeddingProvider();
    const { store, insertedExcerpts, embeddingUpdates } = makeStore(
      true,
      multiTopic,
    );
    const routeSend = vi.fn().mockResolvedValue(undefined);

    const batch = createMessageBatch("wr-classify", [
      { id: "classify-4", timestamp, attempts: 1, body: validSignalStage },
    ]);
    const ctx = createExecutionContext();
    await handleQueueBatch(
      batch,
      { ...env, ROUTE_QUEUE: { send: routeSend } },
      handlersWith({
        store,
        provider,
        embedder,
        pipelineModel: "claude-haiku-4-5-20251001",
      }),
    );
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(["classify-4"]);
    expect(provider.calls.map((call) => call.opts.purpose)).toEqual([
      "judgments",
      "excerpts",
    ]);
    expect(insertedExcerpts).toHaveLength(1);
    const excerpts = insertedExcerpts[0] ?? [];
    expect(excerpts.map((excerpt) => excerpt.topicHint)).toEqual([
      "provider care",
      "billing",
    ]);
    for (const excerpt of excerpts) {
      // Verbatim slice invariant, straight off the real workerd run.
      expect(
        multiTopic.slice(
          excerpt.startOffset,
          excerpt.startOffset + excerpt.text.length,
        ),
      ).toBe(excerpt.text);
    }
    expect(embeddingUpdates).toHaveLength(2);
    expect(embeddingUpdates.map((update) => update.embeddingModel)).toEqual([
      "fake-bge-m3",
      "fake-bge-m3",
    ]);
    expect(routeSend).toHaveBeenCalledTimes(1);
  });

  it("forwards to the classify DLQ and acks when the signal row is gone", async () => {
    const { store } = makeStore(false);
    const dlqSend = vi.fn().mockResolvedValue(undefined);

    const batch = createMessageBatch("wr-classify", [
      { id: "classify-2", timestamp, attempts: 1, body: validSignalStage },
    ]);
    const ctx = createExecutionContext();
    await handleQueueBatch(
      batch,
      { ...env, CLASSIFY_DLQ: { send: dlqSend } },
      handlersWith({
        store,
        provider: new FakeAiProvider(),
        pipelineModel: "claude-haiku-4-5-20251001",
      }),
    );
    const result = await getQueueResult(batch, ctx);

    expect(dlqSend).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: DLQ_FORWARD_KIND,
        stage: "classify",
        reason: "non_retryable",
        body: validSignalStage,
      }),
    );
    expect(result.explicitAcks).toEqual(["classify-2"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("retries when the provider is unconfigured (missing ANTHROPIC_API_KEY posture)", async () => {
    const { store, inserted } = makeStore(true);

    const batch = createMessageBatch("wr-classify", [
      { id: "classify-3", timestamp, attempts: 1, body: validSignalStage },
    ]);
    const ctx = createExecutionContext();
    await handleQueueBatch(
      batch,
      env,
      handlersWith({
        store,
        provider: undefined,
        pipelineModel: "claude-haiku-4-5-20251001",
      }),
    );
    const result = await getQueueResult(batch, ctx);

    expect(result.retryMessages).toEqual([{ msgId: "classify-3" }]);
    expect(result.explicitAcks).toEqual([]);
    expect(inserted).toHaveLength(0);
  });
});

describe("route stage on a real workerd batch (issue #108)", () => {
  // The real `route` handler wires Postgres off env; here the dispatcher
  // runs against the real Queues runtime with the store seam injected
  // (in-memory RouteStore + the interim audit-only sinks), so the
  // assertions cover the actual ack/retry outcomes the platform records.
  // The full Postgres-backed path runs in test/route.integration.test.ts.

  function routeSignalFixture(
    overrides: Partial<SignalForRouting> = {},
  ): SignalForRouting {
    return {
      visibility: "public",
      originalText:
        "Dr. Patel explained every step of my cleaning and the front desk " +
        "sorted my insurance without me asking twice.",
      originalRating: "5.0",
      retentionState: "active",
      classificationPending: false,
      pipelineStatus: "pending_route",
      ...overrides,
    };
  }

  function makeRouteStore(
    signal: SignalForRouting | undefined,
    derivations: Partial<RoutingDerivations> = {},
  ) {
    const committed: RoutingOutcome[] = [];
    const store: RouteStore = {
      getSignal: async () => signal,
      getCurrentDerivations: async () => ({
        sentiment: undefined,
        urgency: undefined,
        response_risk: undefined,
        publication_suitability: undefined,
        ...derivations,
      }),
      commitRouting: async (_message, outcome) => {
        committed.push(outcome);
      },
    };
    return { store, committed };
  }

  function handlersWithRoute(deps: RouteDeps): StageHandlers {
    return {
      ...stageHandlers,
      route: (message, _env) => routeSignal(message, deps),
    };
  }

  it("acks after committing all three branches through the sinks in one outcome", async () => {
    const { store, committed } = makeRouteStore(routeSignalFixture(), {
      sentiment: {
        value: "positive",
        confidence: 0.95,
        basis: "inferred_text",
      },
      urgency: { value: "critical", confidence: 0.85, basis: "inferred_text" },
      publication_suitability: {
        value: "suitable",
        confidence: 0.9,
        basis: "inferred_text",
      },
    });
    const recoveryCalls: unknown[] = [];
    const deps: RouteDeps = {
      store,
      recovery: {
        openRecoveryItem: async (signal, urgency, context) => {
          recoveryCalls.push(urgency);
          await auditOnlyRecoverySink.openRecoveryItem(
            signal,
            urgency,
            context,
          );
        },
      },
      proof: auditOnlyProofSink,
      config: defaultRoutingConfig,
    };

    const batch = createMessageBatch("wr-route", [
      { id: "route-1", timestamp, attempts: 1, body: validSignalStage },
    ]);
    const ctx = createExecutionContext();
    await handleQueueBatch(batch, env, handlersWithRoute(deps));
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(["route-1"]);
    expect(result.retryMessages).toEqual([]);
    expect(recoveryCalls).toEqual(["critical"]);
    expect(committed).toHaveLength(1);
    expect(committed[0]?.audits.map((audit) => audit.action)).toEqual([
      "signal.routed_urgent",
      "signal.entered_review_inbox",
      "signal.proof_candidate",
    ]);
    expect(committed[0]?.stats).toEqual({
      route_urgent: 1,
      route_review_inbox: 1,
      route_proof_candidate: 1,
    });
  });

  it("forwards missing-derivations to the route DLQ and acks (never route on absent data)", async () => {
    const { store, committed } = makeRouteStore(
      routeSignalFixture({ visibility: "private" }),
    );
    const dlqSend = vi.fn().mockResolvedValue(undefined);
    const deps: RouteDeps = {
      store,
      recovery: auditOnlyRecoverySink,
      proof: auditOnlyProofSink,
      config: defaultRoutingConfig,
    };

    const batch = createMessageBatch("wr-route", [
      { id: "route-2", timestamp, attempts: 1, body: validSignalStage },
    ]);
    const ctx = createExecutionContext();
    await handleQueueBatch(
      batch,
      { ...env, ROUTE_DLQ: { send: dlqSend } },
      handlersWithRoute(deps),
    );
    const result = await getQueueResult(batch, ctx);

    expect(dlqSend).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: DLQ_FORWARD_KIND,
        stage: "route",
        reason: "non_retryable",
        error: expect.stringContaining("no derivations"),
        body: validSignalStage,
      }),
    );
    expect(result.explicitAcks).toEqual(["route-2"]);
    expect(result.retryMessages).toEqual([]);
    expect(committed).toHaveLength(0);
  });

  it("retries when the routing commit fails (transient Postgres trouble)", async () => {
    const { store } = makeRouteStore(routeSignalFixture(), {
      sentiment: { value: "negative", confidence: 0.9, basis: "inferred_text" },
    });
    store.commitRouting = async () => {
      throw new Error("connection reset");
    };
    const deps: RouteDeps = {
      store,
      recovery: auditOnlyRecoverySink,
      proof: auditOnlyProofSink,
      config: defaultRoutingConfig,
    };

    const batch = createMessageBatch("wr-route", [
      { id: "route-3", timestamp, attempts: 1, body: validSignalStage },
    ]);
    const ctx = createExecutionContext();
    await handleQueueBatch(batch, env, handlersWithRoute(deps));
    const result = await getQueueResult(batch, ctx);

    expect(result.retryMessages).toEqual([{ msgId: "route-3" }]);
    expect(result.explicitAcks).toEqual([]);
  });
});

describe("worker.fetch (local debug enqueue)", () => {
  it("enqueues onto the real local queue binding and returns 202", async () => {
    // Use a fake producer to observe the send without depending on
    // simulated delivery timing.
    const send = vi.fn().mockResolvedValue(undefined);
    const request = new Request(
      "http://localhost:8788/__local/enqueue/ingest",
      {
        method: "POST",
        body: JSON.stringify(validIngest),
      },
    ) as Request<unknown, IncomingRequestCfProperties>;
    const response = await worker.fetch(
      request,
      { ...env, INGEST_QUEUE: { send } },
      createExecutionContext(),
    );
    expect(response.status).toBe(202);
    expect(send).toHaveBeenCalledExactlyOnceWith(validIngest);
  });

  it("exposes the real INGEST_QUEUE producer binding locally", () => {
    // wrangler.jsonc binds INGEST_QUEUE only in the top-level (local) block;
    // this suite runs against that block, so the binding must exist here.
    expect(env.INGEST_QUEUE).toBeDefined();
    expect(env.ENVIRONMENT).toBe("local");
  });
});
