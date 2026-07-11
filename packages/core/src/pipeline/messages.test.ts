import { describe, expect, it } from "vitest";

import {
  buildDlqForwardEnvelope,
  classifyMessageSchema,
  DLQ_FORWARD_KIND,
  dedupeMessageSchema,
  dlqForwardEnvelopeSchema,
  extractRequestId,
  fallbackRequestId,
  identifyPipelineQueue,
  ingestMessageSchema,
  interpretDlqMessage,
  parsePipelineMessage,
  routeMessageSchema,
  UNKNOWN_REQUEST_ID_PREFIX,
} from "./messages.js";

const uuid = "8a9c1a52-6a54-4d43-9c39-9d5df2bb0e1a";
const otherUuid = "3f2b6a1e-90cd-4f5e-8a2f-1b0f4a7c9d21";
const requestId = "5e0f7ad2-3a9f-4a56-8f18-1b2c3d4e5f60";

const validIngest = {
  importRunId: uuid,
  rawArtifactKey: "raw/google/8a9c/sha256-abc123",
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

describe("message schemas", () => {
  it("accepts a valid IngestMessage", () => {
    expect(ingestMessageSchema.parse(validIngest)).toEqual(validIngest);
  });

  it("rejects an IngestMessage with a missing field", () => {
    const { rawArtifactKey: _dropped, ...missing } = validIngest;
    expect(ingestMessageSchema.safeParse(missing).success).toBe(false);
  });

  it("rejects an IngestMessage with an unknown sourceKind", () => {
    const result = ingestMessageSchema.safeParse({
      ...validIngest,
      sourceKind: "yelp",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an IngestMessage with a non-uuid practiceId", () => {
    const result = ingestMessageSchema.safeParse({
      ...validIngest,
      practiceId: "practice-1",
    });
    expect(result.success).toBe(false);
  });

  it.each([
    ["dedupe", dedupeMessageSchema],
    ["classify", classifyMessageSchema],
    ["route", routeMessageSchema],
  ] as const)("accepts a valid %s message", (_stage, schema) => {
    expect(schema.parse(validSignalStage)).toEqual(validSignalStage);
  });

  it.each([
    ["dedupe", dedupeMessageSchema],
    ["classify", classifyMessageSchema],
    ["route", routeMessageSchema],
  ] as const)("rejects a %s message missing signalId", (_stage, schema) => {
    const { signalId: _dropped, ...missing } = validSignalStage;
    expect(schema.safeParse(missing).success).toBe(false);
  });

  it("rejects a mistyped signalId", () => {
    const result = dedupeMessageSchema.safeParse({
      ...validSignalStage,
      signalId: 42,
    });
    expect(result.success).toBe(false);
  });
});

describe("identifyPipelineQueue", () => {
  it.each([
    ["wr-ingest", "ingest", false],
    ["wr-dedupe", "dedupe", false],
    ["wr-classify", "classify", false],
    ["wr-route", "route", false],
    ["wr-ingest-dlq", "ingest", true],
    ["wr-route-dlq", "route", true],
    ["wr-ingest-preview", "ingest", false],
    ["wr-classify-prod", "classify", false],
    ["wr-dedupe-dlq-preview", "dedupe", true],
    ["wr-route-dlq-prod", "route", true],
  ] as const)("resolves %s", (queueName, stage, isDlq) => {
    expect(identifyPipelineQueue(queueName)).toEqual({ stage, isDlq });
  });

  it.each([
    "wr-ingest-staging",
    "wr-embed",
    "ingest",
    "wr-ingest-dlq-dlq",
    "",
  ])("returns null for %j", (queueName) => {
    expect(identifyPipelineQueue(queueName)).toBeNull();
  });
});

describe("parsePipelineMessage", () => {
  it("returns the typed message for a valid body, discriminated on stage", () => {
    const result = parsePipelineMessage("wr-ingest", validIngest);
    expect(result).toEqual({ ok: true, stage: "ingest", message: validIngest });
  });

  it("resolves env-suffixed queue names to the same stage schema", () => {
    const result = parsePipelineMessage("wr-dedupe-prod", validSignalStage);
    expect(result).toEqual({
      ok: true,
      stage: "dedupe",
      message: validSignalStage,
    });
  });

  it("returns a typed invalid_message error for a body that fails the schema", () => {
    const result = parsePipelineMessage("wr-classify", { signalId: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.error.kind).toBe("invalid_message");
    expect(result.error).toMatchObject({
      queueName: "wr-classify",
      stage: "classify",
    });
    expect(result.error.detail).toContain("practiceId");
  });

  it("returns unknown_queue for a name outside the topology", () => {
    const result = parsePipelineMessage("wr-embed", validIngest);
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "unknown_queue", queueName: "wr-embed" },
    });
  });

  it("returns unknown_queue for a DLQ name — DLQ bodies are not stage messages", () => {
    const result = parsePipelineMessage("wr-ingest-dlq", validIngest);
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "unknown_queue", queueName: "wr-ingest-dlq" },
    });
  });

  it("never throws on garbage bodies", () => {
    for (const body of [null, undefined, 42, "text", [], { nested: {} }]) {
      expect(parsePipelineMessage("wr-route", body).ok).toBe(false);
    }
  });
});

describe("requestId propagation (issue #64)", () => {
  it("schemas accept OLD messages without requestId (wire compat)", () => {
    const { requestId: _dropped, ...legacyIngest } = validIngest;
    const { requestId: _alsoDropped, ...legacyStage } = validSignalStage;
    expect(ingestMessageSchema.safeParse(legacyIngest).success).toBe(true);
    expect(dedupeMessageSchema.safeParse(legacyStage).success).toBe(true);
    expect(classifyMessageSchema.safeParse(legacyStage).success).toBe(true);
    expect(routeMessageSchema.safeParse(legacyStage).success).toBe(true);
  });

  it("rejects an empty-string requestId", () => {
    expect(
      dedupeMessageSchema.safeParse({ ...validSignalStage, requestId: "" })
        .success,
    ).toBe(false);
  });

  it("parsePipelineMessage preserves a propagated requestId", () => {
    const result = parsePipelineMessage("wr-classify", validSignalStage);
    if (!result.ok) throw new Error("expected ok");
    expect(result.message.requestId).toBe(requestId);
  });

  it("parsePipelineMessage backfills unknown-<uuid> for legacy messages", () => {
    const { requestId: _dropped, ...legacyStage } = validSignalStage;
    const result = parsePipelineMessage("wr-classify", legacyStage);
    if (!result.ok) throw new Error("expected ok");
    expect(result.message.requestId).toMatch(
      new RegExp(`^${UNKNOWN_REQUEST_ID_PREFIX}[0-9a-f-]{36}$`),
    );
  });

  it("fallbackRequestId mints unique unknown- ids", () => {
    const a = fallbackRequestId();
    const b = fallbackRequestId();
    expect(a.startsWith(UNKNOWN_REQUEST_ID_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("extractRequestId pulls a string requestId out of an unknown body", () => {
    expect(extractRequestId({ requestId, other: 1 })).toBe(requestId);
  });

  it.each([
    null,
    42,
    "text",
    {},
    { requestId: 7 },
    { requestId: "" },
  ])("extractRequestId falls back to unknown- for %j", (body) => {
    expect(extractRequestId(body).startsWith(UNKNOWN_REQUEST_ID_PREFIX)).toBe(
      true,
    );
  });

  it("the DLQ forward envelope carries requestId and accepts old envelopes without it", () => {
    const envelope = buildDlqForwardEnvelope({
      stage: "dedupe",
      reason: "malformed",
      error: "invalid_message",
      body: { broken: true },
      requestId,
    });
    expect(envelope.requestId).toBe(requestId);
    expect(dlqForwardEnvelopeSchema.safeParse(envelope).success).toBe(true);

    const { requestId: _dropped, ...legacyEnvelope } = envelope;
    expect(dlqForwardEnvelopeSchema.safeParse(legacyEnvelope).success).toBe(
      true,
    );
  });
});

describe("DLQ envelopes", () => {
  it("round-trips a dispatcher-forwarded envelope through interpretDlqMessage", () => {
    const envelope = buildDlqForwardEnvelope({
      stage: "dedupe",
      reason: "malformed",
      error: "invalid_message: signalId missing",
      body: { signalId: 42 },
    });
    expect(envelope.kind).toBe(DLQ_FORWARD_KIND);
    expect(new Date(envelope.occurredAt).getTime()).not.toBeNaN();

    expect(interpretDlqMessage("dedupe", envelope)).toEqual({
      stage: "dedupe",
      reason: "malformed",
      errorMessage: "invalid_message: signalId missing",
      body: { signalId: 42 },
    });
  });

  it("treats a bare body as a platform dead-letter (retries exhausted)", () => {
    const failure = interpretDlqMessage("route", validSignalStage);
    expect(failure.stage).toBe("route");
    expect(failure.reason).toBe("retries_exhausted");
    expect(failure.body).toEqual(validSignalStage);
    expect(failure.errorMessage).toContain("max_retries");
  });

  it("treats a non-envelope object as a platform dead-letter too", () => {
    const failure = interpretDlqMessage("ingest", { kind: "something-else" });
    expect(failure.reason).toBe("retries_exhausted");
  });
});
