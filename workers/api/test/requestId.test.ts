/**
 * Request-id middleware tests (issue #64): the id is minted (or honored) at
 * the edge, echoed in the `x-request-id` response header, present in every
 * structured log line, and copied into queue messages by producing routes —
 * the propagation hop that makes one signal traceable end to end.
 */

import {
  type IngestMessage,
  parsePipelineMessage,
  REQUEST_ID_HEADER,
  resetEnvCache,
} from "@wellregarded/core";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { app } from "../src/app";
import type { AppEnv } from "../src/bindings";
import { requestId } from "../src/middleware/requestId";
import { testEnv } from "./support/env";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeEach(() => {
  resetEnvCache();
  vi.restoreAllMocks();
});

describe("x-request-id on responses", () => {
  it("mints a UUID when the request carries no id", async () => {
    const res = await app.request("/healthz", {}, testEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(UUID_PATTERN);
  });

  it("honors and echoes a well-formed inbound x-request-id", async () => {
    const res = await app.request(
      "/healthz",
      { headers: { [REQUEST_ID_HEADER]: "inbound-id-123" } },
      testEnv(),
    );
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe("inbound-id-123");
  });

  it("falls back to cf-ray when no x-request-id is present", async () => {
    const res = await app.request(
      "/healthz",
      { headers: { "cf-ray": "8f00abcd1234-ORD" } },
      testEnv(),
    );
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe("8f00abcd1234-ORD");
  });

  it("discards a malformed inbound id and mints a fresh one", async () => {
    const res = await app.request(
      "/healthz",
      { headers: { [REQUEST_ID_HEADER]: "x".repeat(200) } },
      testEnv(),
    );
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(UUID_PATTERN);
  });

  it("carries the id on error responses too (onError path)", async () => {
    // An empty env fails apiEnvSchema inside /healthz → app.onError.
    const res = await app.request(
      "/healthz",
      { headers: { [REQUEST_ID_HEADER]: "err-req-1" } },
      { HYPERDRIVE: { connectionString: "" } },
    );
    expect(res.status).toBe(500);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe("err-req-1");
  });
});

describe("requestId in log lines", () => {
  it("onError logs a structured JSON line carrying the requestId", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await app.request(
      "/healthz",
      { headers: { [REQUEST_ID_HEADER]: "err-req-2" } },
      {}, // invalid env → getEnv throws → onError
    );
    expect(res.status).toBe(500);
    // No internals in the response body…
    expect(await res.json()).toEqual({ error: "internal" });
    // …but a structured error log server-side, bound to the request id.
    const records = spy.mock.calls.map((call) => JSON.parse(call[0] as string));
    const errorLine = records.find((record) => record.level === "error");
    expect(errorLine).toMatchObject({
      worker: "api",
      requestId: "err-req-2",
      msg: "unhandled error",
      stage: "/healthz",
    });
    expect(errorLine?.error).toMatchObject({ kind: "Error" });
  });
});

describe("requestId propagation into queue sends", () => {
  it('a producing route copies c.get("requestId") into the message envelope', async () => {
    // A minimal producing route using the real middleware and the real
    // envelope schema — the exact pattern deployed ingest routes must
    // follow (workers/api has no production queue producer route yet).
    const send = vi.fn().mockResolvedValue(undefined);
    const producerApp = new Hono<AppEnv>();
    producerApp.use("*", requestId());
    producerApp.post("/ingest", async (c) => {
      const message: IngestMessage = {
        importRunId: "8a9c1a52-6a54-4d43-9c39-9d5df2bb0e1a",
        rawArtifactKey: "raw/google/sha256-abc123",
        sourceKind: "google",
        practiceId: "3f2b6a1e-90cd-4f5e-8a2f-1b0f4a7c9d21",
        requestId: c.get("requestId"),
      };
      await (c.env.INGEST_QUEUE as { send(body: unknown): Promise<void> }).send(
        message,
      );
      return c.json({ queued: true });
    });

    const res = await producerApp.request(
      "/ingest",
      { method: "POST", headers: { [REQUEST_ID_HEADER]: "trace-me-1" } },
      testEnv({ INGEST_QUEUE: { send } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe("trace-me-1");

    // The queue message carries the same id the response echoed…
    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ requestId: "trace-me-1" }),
    );
    // …and the consumer-side parser hands it to the pipeline verbatim.
    const sent = send.mock.calls[0]?.[0];
    const parsed = parsePipelineMessage("wr-ingest", sent);
    if (!parsed.ok) throw new Error("expected a valid ingest message");
    expect(parsed.message.requestId).toBe("trace-me-1");
  });
});
