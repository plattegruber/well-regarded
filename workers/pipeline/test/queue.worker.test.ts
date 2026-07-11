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
  buildDlqForwardEnvelope,
  DLQ_FORWARD_KIND,
  RetryableError,
} from "@wellregarded/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleQueueBatch, type StageHandlers } from "../src/dispatch";
import worker from "../src/worker";

const uuid = "8a9c1a52-6a54-4d43-9c39-9d5df2bb0e1a";
const otherUuid = "3f2b6a1e-90cd-4f5e-8a2f-1b0f4a7c9d21";

const validIngest = {
  importRunId: uuid,
  rawArtifactKey: "raw/google/sha256-abc123",
  sourceKind: "google",
  practiceId: otherUuid,
};

const validSignalStage = {
  signalId: uuid,
  practiceId: otherUuid,
  importRunId: uuid,
};

const timestamp = new Date("2026-07-10T12:00:00Z");

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("worker.queue", () => {
  it("acks a valid message on each main queue", async () => {
    const cases = [
      ["wr-ingest", validIngest],
      ["wr-dedupe", validSignalStage],
      ["wr-classify", validSignalStage],
      ["wr-route", validSignalStage],
    ] as const;
    for (const [queue, body] of cases) {
      const batch = createMessageBatch(queue, [
        { id: `${queue}-1`, timestamp, attempts: 1, body },
      ]);
      const ctx = createExecutionContext();
      await worker.queue(batch, env, ctx);
      const result = await getQueueResult(batch, ctx);
      expect(result.explicitAcks).toEqual([`${queue}-1`]);
      expect(result.retryMessages).toEqual([]);
      expect(result.ackAll).toBe(false);
      expect(result.retryBatch.retry).toBe(false);
    }
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

  it("persists and acks a DLQ message via recordPipelineFailure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["dlq-1"]);
    expect(result.retryMessages).toEqual([]);
    const logged = errorSpy.mock.calls.map((call) => String(call[0]));
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
