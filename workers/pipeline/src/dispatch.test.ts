import {
  DLQ_FORWARD_KIND,
  NonRetryableError,
  RetryableError,
  UNKNOWN_REQUEST_ID_PREFIX,
} from "@wellregarded/core";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import type { PipelineBindings } from "./bindings";
import {
  handleQueueBatch,
  type QueueMessageLike,
  type StageHandlers,
} from "./dispatch";

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

interface FakeMessage extends QueueMessageLike {
  ack: Mock;
  retry: Mock;
}

let nextId = 0;

function makeMessage(body: unknown): FakeMessage {
  nextId += 1;
  return {
    id: `msg-${nextId}`,
    timestamp: new Date("2026-07-10T12:00:00Z"),
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

interface FakeProducer {
  send: Mock;
}

type FakeEnv = PipelineBindings & {
  DEDUPE_QUEUE: FakeProducer;
  CLASSIFY_QUEUE: FakeProducer;
  ROUTE_QUEUE: FakeProducer;
  INGEST_DLQ: FakeProducer;
  DEDUPE_DLQ: FakeProducer;
  CLASSIFY_DLQ: FakeProducer;
  ROUTE_DLQ: FakeProducer;
};

function makeEnv(): FakeEnv {
  const producer = (): FakeProducer => ({
    send: vi.fn().mockResolvedValue(undefined),
  });
  return {
    ENVIRONMENT: "local",
    // Never touched by these tests — the stage handlers are injected fakes.
    RAW_ARTIFACTS: {
      head: async () => null,
      put: async () => undefined,
      get: async () => null,
    },
    // No HYPERDRIVE: the DLQ consumer degrades to its log-only path, which
    // is exactly what these unit tests assert.
    DEDUPE_QUEUE: producer(),
    CLASSIFY_QUEUE: producer(),
    ROUTE_QUEUE: producer(),
    INGEST_DLQ: producer(),
    DEDUPE_DLQ: producer(),
    CLASSIFY_DLQ: producer(),
    ROUTE_DLQ: producer(),
  };
}

type FakeHandlers = StageHandlers & Record<keyof StageHandlers, Mock>;

function makeHandlers(): FakeHandlers {
  return {
    ingest: vi.fn().mockResolvedValue(undefined),
    dedupe: vi.fn().mockResolvedValue(undefined),
    classify: vi.fn().mockResolvedValue(undefined),
    route: vi.fn().mockResolvedValue(undefined),
  };
}

async function dispatchOne(
  queue: string,
  body: unknown,
  {
    env = makeEnv(),
    handlers = makeHandlers(),
  }: { env?: FakeEnv; handlers?: FakeHandlers } = {},
): Promise<{ message: FakeMessage; env: FakeEnv; handlers: FakeHandlers }> {
  const message = makeMessage(body);
  await handleQueueBatch({ queue, messages: [message] }, env, handlers);
  return { message, env, handlers };
}

beforeEach(() => {
  vi.restoreAllMocks();
  // The dispatcher logs retries/DLQ activity; keep test output clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("stage dispatch", () => {
  it("routes a valid message to its stage handler and acks", async () => {
    const { message, env, handlers } = await dispatchOne(
      "wr-dedupe",
      validSignalStage,
    );
    expect(handlers.dedupe).toHaveBeenCalledExactlyOnceWith(
      validSignalStage,
      env,
    );
    expect(handlers.ingest).not.toHaveBeenCalled();
    expect(handlers.classify).not.toHaveBeenCalled();
    expect(handlers.route).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("routes the ingest queue to the normalize (ingest) handler", async () => {
    const { handlers } = await dispatchOne("wr-ingest", validIngest);
    expect(handlers.ingest).toHaveBeenCalledExactlyOnceWith(
      validIngest,
      expect.anything(),
    );
  });

  it("resolves env-suffixed queue names to the same stage", async () => {
    const { handlers } = await dispatchOne(
      "wr-classify-prod",
      validSignalStage,
    );
    expect(handlers.classify).toHaveBeenCalledOnce();
  });

  it("retries every message on a queue outside the topology", async () => {
    const handlers = makeHandlers();
    const first = makeMessage(validIngest);
    const second = makeMessage(validSignalStage);
    await handleQueueBatch(
      { queue: "wr-mystery", messages: [first, second] },
      makeEnv(),
      handlers,
    );
    expect(first.retry).toHaveBeenCalledOnce();
    expect(second.retry).toHaveBeenCalledOnce();
    expect(first.ack).not.toHaveBeenCalled();
    expect(handlers.ingest).not.toHaveBeenCalled();
  });
});

describe("malformed messages (zod parse failure)", () => {
  it("forwards to the stage DLQ and acks, never retries", async () => {
    const bad = { signalId: "not-a-uuid" };
    const { message, env, handlers } = await dispatchOne("wr-dedupe", bad);
    expect(handlers.dedupe).not.toHaveBeenCalled();
    expect(env.DEDUPE_DLQ.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: DLQ_FORWARD_KIND,
        stage: "dedupe",
        reason: "malformed",
        body: bad,
        error: expect.stringContaining("signalId"),
      }),
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("targets the DLQ of the queue the message arrived on", async () => {
    const { env } = await dispatchOne("wr-route", null);
    expect(env.ROUTE_DLQ.send).toHaveBeenCalledOnce();
    expect(env.INGEST_DLQ.send).not.toHaveBeenCalled();
  });

  it("retries (not acks) when the DLQ forward itself fails, so nothing is dropped", async () => {
    const env = makeEnv();
    env.INGEST_DLQ.send.mockRejectedValue(new Error("queue unavailable"));
    const { message } = await dispatchOne("wr-ingest", "garbage", { env });
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("does not let one poison message affect its batch-mates", async () => {
    const env = makeEnv();
    const handlers = makeHandlers();
    const poison = makeMessage({ nope: true });
    const healthy = makeMessage(validSignalStage);
    await handleQueueBatch(
      { queue: "wr-classify", messages: [poison, healthy] },
      env,
      handlers,
    );
    expect(env.CLASSIFY_DLQ.send).toHaveBeenCalledOnce();
    expect(poison.ack).toHaveBeenCalledOnce();
    expect(handlers.classify).toHaveBeenCalledExactlyOnceWith(
      validSignalStage,
      env,
    );
    expect(healthy.ack).toHaveBeenCalledOnce();
    expect(healthy.retry).not.toHaveBeenCalled();
  });
});

describe("handler failures", () => {
  it("retries on RetryableError (transient)", async () => {
    const handlers = makeHandlers();
    handlers.dedupe.mockRejectedValue(new RetryableError("db timeout"));
    const { message, env } = await dispatchOne("wr-dedupe", validSignalStage, {
      handlers,
    });
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(env.DEDUPE_DLQ.send).not.toHaveBeenCalled();
  });

  it("retries on an unexpected error (might be transient)", async () => {
    const handlers = makeHandlers();
    handlers.route.mockRejectedValue(new TypeError("boom"));
    const { message } = await dispatchOne("wr-route", validSignalStage, {
      handlers,
    });
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("forwards to the DLQ and acks on NonRetryableError (permanent)", async () => {
    const handlers = makeHandlers();
    handlers.classify.mockRejectedValue(
      new NonRetryableError("signal row was purged"),
    );
    const { message, env } = await dispatchOne(
      "wr-classify",
      validSignalStage,
      { handlers },
    );
    expect(env.CLASSIFY_DLQ.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: DLQ_FORWARD_KIND,
        stage: "classify",
        reason: "non_retryable",
        error: "signal row was purged",
        body: validSignalStage,
      }),
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });
});

describe("DLQ consumption", () => {
  // These fake envs bind no HYPERDRIVE, so the DLQ consumer takes its
  // log-only fallback (createLogger → console.log); the Postgres-backed
  // recordPipelineFailure path is covered by the pipeline integration suite.
  it("persists the failure (via the log-only fallback) and acks", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { message, handlers } = await dispatchOne("wr-dedupe-dlq", {
      kind: DLQ_FORWARD_KIND,
      stage: "dedupe",
      reason: "malformed",
      error: "signalId missing",
      body: { broken: true },
      occurredAt: "2026-07-10T12:00:00.000Z",
    });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    // DLQ messages never reach stage handlers.
    expect(handlers.dedupe).not.toHaveBeenCalled();
    const logged = logSpy.mock.calls.map((call) => String(call[0]));
    expect(
      logged.some(
        (line) =>
          line.includes("pipeline.failure") && line.includes("malformed"),
      ),
    ).toBe(true);
  });

  it("normalizes a bare platform dead-letter (retries exhausted)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { message } = await dispatchOne("wr-route-dlq", validSignalStage);
    expect(message.ack).toHaveBeenCalledOnce();
    const logged = logSpy.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes("retries_exhausted"))).toBe(
      true,
    );
  });

  it("still acks when persistence throws: a DLQ consumer never retry-loops", async () => {
    // A circular body makes recordPipelineFailure's JSON.stringify throw.
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const { message } = await dispatchOne("wr-ingest-dlq", circular);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });
});

describe("requestId tracing (issue #64)", () => {
  it("dispatcher retry logs carry the message's requestId", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const handlers = makeHandlers();
    handlers.dedupe.mockRejectedValue(new TypeError("boom"));
    await dispatchOne("wr-dedupe", validSignalStage, { handlers });
    const records = logSpy.mock.calls.map((call) =>
      JSON.parse(String(call[0])),
    );
    const retryLine = records.find(
      (record) => record.msg === "pipeline.dispatch.retry",
    );
    expect(retryLine).toMatchObject({
      level: "error",
      worker: "pipeline",
      stage: "dedupe",
      requestId,
      practiceId: otherUuid,
    });
  });

  it("delivers a legacy message (no requestId) with an unknown- backfill", async () => {
    const { requestId: _dropped, ...legacy } = validSignalStage;
    const { handlers } = await dispatchOne("wr-dedupe", legacy);
    expect(handlers.dedupe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ...legacy,
        requestId: expect.stringMatching(
          new RegExp(`^${UNKNOWN_REQUEST_ID_PREFIX}`),
        ),
      }),
      expect.anything(),
    );
  });

  it("malformed messages forward to the DLQ with a best-effort requestId", async () => {
    const bad = { signalId: "not-a-uuid", requestId: "trace-mal-1" };
    const { env } = await dispatchOne("wr-dedupe", bad);
    expect(env.DEDUPE_DLQ.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        reason: "malformed",
        requestId: "trace-mal-1",
      }),
    );
  });

  it("non-retryable forwards carry the message's requestId in the envelope", async () => {
    const handlers = makeHandlers();
    handlers.route.mockRejectedValue(new NonRetryableError("gone"));
    const { env } = await dispatchOne("wr-route", validSignalStage, {
      handlers,
    });
    expect(env.ROUTE_DLQ.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: "non_retryable", requestId }),
    );
  });
});
