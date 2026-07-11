import { resetEnvCache } from "@wellregarded/core";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import type { PipelineBindings } from "./bindings";
import { handleLocalEnqueue } from "./localEnqueue";

type FakeEnv = PipelineBindings & { INGEST_QUEUE?: { send: Mock } };

function makeEnv(environment = "local"): FakeEnv {
  const producer = () => ({ send: vi.fn().mockResolvedValue(undefined) });
  return {
    ENVIRONMENT: environment,
    DEDUPE_QUEUE: producer(),
    CLASSIFY_QUEUE: producer(),
    ROUTE_QUEUE: producer(),
    INGEST_DLQ: producer(),
    DEDUPE_DLQ: producer(),
    CLASSIFY_DLQ: producer(),
    ROUTE_DLQ: producer(),
    INGEST_QUEUE: producer(),
  };
}

function post(path: string, body: string): Request {
  return new Request(`http://localhost:8788${path}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  // getEnv caches per schema per isolate; tests vary ENVIRONMENT, so reset.
  resetEnvCache();
});

describe("handleLocalEnqueue", () => {
  it("enqueues the raw body onto the requested stage's queue", async () => {
    const env = makeEnv();
    const body = { signalId: "not-even-valid" };
    const response = await handleLocalEnqueue(
      post("/__local/enqueue/dedupe", JSON.stringify(body)),
      env,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ queued: "dedupe" });
    const producer = env.DEDUPE_QUEUE as { send: Mock };
    expect(producer.send).toHaveBeenCalledExactlyOnceWith(body);
  });

  it("feeds the spine's front door via the local-only INGEST_QUEUE binding", async () => {
    const env = makeEnv();
    const response = await handleLocalEnqueue(
      post("/__local/enqueue/ingest", "{}"),
      env,
    );
    expect(response.status).toBe(202);
    expect(env.INGEST_QUEUE?.send).toHaveBeenCalledOnce();
  });

  it("explains when the ingest producer is not bound", async () => {
    const env = makeEnv();
    delete env.INGEST_QUEUE;
    const response = await handleLocalEnqueue(
      post("/__local/enqueue/ingest", "{}"),
      env,
    );
    expect(response.status).toBe(500);
  });

  it("is a hard 404 outside the local environment", async () => {
    const response = await handleLocalEnqueue(
      post("/__local/enqueue/dedupe", "{}"),
      makeEnv("prod"),
    );
    expect(response.status).toBe(404);
  });

  it("404s unknown paths and stages", async () => {
    const env = makeEnv();
    for (const path of ["/", "/__local/enqueue/embed", "/__local/enqueue"]) {
      const response = await handleLocalEnqueue(post(path, "{}"), env);
      expect(response.status).toBe(404);
    }
  });

  it("405s non-POST methods", async () => {
    const response = await handleLocalEnqueue(
      new Request("http://localhost:8788/__local/enqueue/dedupe"),
      makeEnv(),
    );
    expect(response.status).toBe(405);
  });

  it("400s a non-JSON body", async () => {
    const response = await handleLocalEnqueue(
      post("/__local/enqueue/route", "not json"),
      makeEnv(),
    );
    expect(response.status).toBe(400);
  });
});
