/**
 * Wrapper-mechanics tests for `AnthropicProvider` (issue #63): the
 * Anthropic SDK transport is mocked at the `fetch` seam, so these tests
 * exercise the real SDK request/response/error parsing without any
 * network. Retry timing is driven through the injected `sleep`/`random`.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AnthropicProvider, RESULT_TOOL_NAME } from "./anthropic.js";
import {
  AiRequestError,
  AiResponseError,
  AiValidationError,
} from "./errors.js";
import type { AiCallRecord } from "./provider.js";

const MODELS = {
  pipeline: "claude-haiku-4-5-20251001",
  drafting: "claude-sonnet-5",
};

const schema = z.object({
  sentiment: z.enum(["positive", "negative"]),
  confidence: z.number(),
});

const prompt = {
  name: "judgments/v1",
  system: "You classify dental-practice reviews.",
  user: "Review: the hygienist was wonderful.",
};

const opts = {
  purpose: "judgments",
  practiceId: "11111111-1111-1111-1111-111111111111",
};

const JSON_HEADERS = { "content-type": "application/json" };

/** A successful Messages API response carrying one forced tool_use block. */
function toolUseResponse(
  input: unknown,
  usage: { input_tokens: number; output_tokens: number } = {
    input_tokens: 100,
    output_tokens: 25,
  },
): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: MODELS.pipeline,
      content: [
        { type: "tool_use", id: "toolu_1", name: RESULT_TOOL_NAME, input },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage,
    }),
    { status: 200, headers: JSON_HEADERS },
  );
}

/** A response that (against the forced tool_choice) carries only text. */
function textOnlyResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: MODELS.pipeline,
      content: [{ type: "text", text: "I refuse to answer as JSON." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 80, output_tokens: 10 },
    }),
    { status: 200, headers: JSON_HEADERS },
  );
}

function apiErrorResponse(status: number, type: string): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message: `${type}!` } }),
    { status, headers: JSON_HEADERS },
  );
}

interface RecordedRequest {
  url: string;
  body: {
    model: string;
    system?: string;
    messages: Array<{ role: string; content: string }>;
    tools: Array<{ name: string; input_schema: Record<string, unknown> }>;
    tool_choice: Record<string, unknown>;
    max_tokens: number;
  };
}

/**
 * Build a provider whose SDK transport pops canned responses off a queue,
 * recording every request body, backoff sleep, and cost-log record.
 */
function makeProvider(
  responses: Array<() => Response>,
  extra: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {},
) {
  const requests: RecordedRequest[] = [];
  const sleeps: number[] = [];
  const logs: AiCallRecord[] = [];

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    // The SDK may call fetch(url, init) or fetch(Request) depending on
    // version; support both so an SDK bump doesn't break the harness.
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const rawBody =
      init?.body !== undefined
        ? String(init.body)
        : input instanceof Request
          ? await input.text()
          : "";
    requests.push({ url, body: JSON.parse(rawBody) });
    const next = responses.shift();
    if (!next) throw new Error("mock fetch: response queue exhausted");
    return next();
  }) as typeof fetch;

  const provider = new AnthropicProvider({
    apiKey: "test-key",
    models: MODELS,
    logAiCall: async (record) => {
      logs.push(record);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    fetch: fetchImpl,
    ...extra,
  });

  return { provider, requests, sleeps, logs };
}

describe("AnthropicProvider.classify", () => {
  it("forces tool-use structured output and returns the zod-parsed value with usage", async () => {
    const { provider, requests, logs } = makeProvider([
      () => toolUseResponse({ sentiment: "positive", confidence: 0.92 }),
    ]);

    const result = await provider.classify(prompt, schema, opts);

    expect(result.value).toEqual({ sentiment: "positive", confidence: 0.92 });
    expect(result.usage).toMatchObject({
      model: MODELS.pipeline,
      inputTokens: 100,
      outputTokens: 25,
    });
    expect(result.usage.latencyMs).toBeGreaterThanOrEqual(0);

    // The request forced our single tool.
    expect(requests).toHaveLength(1);
    const body = requests[0]?.body;
    expect(body?.model).toBe(MODELS.pipeline);
    expect(body?.system).toBe(prompt.system);
    expect(body?.tool_choice).toEqual({
      type: "tool",
      name: RESULT_TOOL_NAME,
      disable_parallel_tool_use: true,
    });
    expect(body?.tools).toHaveLength(1);
    expect(body?.tools[0]?.name).toBe(RESULT_TOOL_NAME);
    expect(body?.tools[0]?.input_schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["sentiment", "confidence"],
    });

    // Exactly one cost-log row, clean.
    expect(logs).toEqual([
      {
        practiceId: opts.practiceId,
        purpose: "judgments",
        model: MODELS.pipeline,
        inputTokens: 100,
        outputTokens: 25,
        latencyMs: expect.any(Number),
        error: null,
      },
    ]);
  });

  it("routes the drafting lane to DRAFTING_MODEL and defaults to pipeline", async () => {
    const { provider, requests } = makeProvider([
      () => toolUseResponse({ sentiment: "positive", confidence: 1 }),
      () => toolUseResponse({ sentiment: "positive", confidence: 1 }),
    ]);

    await provider.classify(prompt, schema, { ...opts, model: "drafting" });
    await provider.classify(prompt, schema, opts);

    expect(requests[0]?.body.model).toBe(MODELS.drafting);
    expect(requests[1]?.body.model).toBe(MODELS.pipeline);
  });

  it("retries once on validation failure, feeding the zod error back to the model", async () => {
    const { provider, requests, logs } = makeProvider([
      // Malformed: sentiment not in the enum.
      () => toolUseResponse({ sentiment: "ecstatic", confidence: 0.9 }),
      () => toolUseResponse({ sentiment: "positive", confidence: 0.9 }),
    ]);

    const result = await provider.classify(prompt, schema, opts);

    expect(result.value).toEqual({ sentiment: "positive", confidence: 0.9 });
    expect(requests).toHaveLength(2);
    // The retry prompt carries the validation feedback.
    const retryUser = requests[1]?.body.messages[0]?.content;
    expect(retryUser).toContain(prompt.user);
    expect(retryUser).toContain("Your previous output failed validation");
    expect(retryUser).toContain("sentiment");

    // BOTH calls were cost-logged — failed validation costs money too.
    expect(logs).toHaveLength(2);
    expect(logs[0]?.error).toMatch(/schema validation failed/);
    expect(logs[1]?.error).toBeNull();
  });

  it("throws AiValidationError when the validation retry also fails, logging both calls", async () => {
    const { provider, logs } = makeProvider([
      () => toolUseResponse({ sentiment: "ecstatic", confidence: 0.9 }),
      () => toolUseResponse({ sentiment: "meh", confidence: 2 }),
    ]);

    await expect(provider.classify(prompt, schema, opts)).rejects.toThrow(
      AiValidationError,
    );
    expect(logs).toHaveLength(2);
    expect(logs[0]?.error).toMatch(/schema validation failed/);
    expect(logs[1]?.error).toMatch(/schema validation failed \(retry\)/);
  });

  it("backs off and retries on 429, then succeeds", async () => {
    const { provider, requests, sleeps, logs } = makeProvider([
      () => apiErrorResponse(429, "rate_limit_error"),
      () => toolUseResponse({ sentiment: "negative", confidence: 0.7 }),
    ]);

    const result = await provider.classify(prompt, schema, opts);

    expect(result.value.sentiment).toBe("negative");
    expect(requests).toHaveLength(2);
    // Equal jitter with random=0.5 and base 1000ms → 750ms first delay.
    expect(sleeps).toEqual([750]);
    // Only the call that produced a response is cost-logged.
    expect(logs).toHaveLength(1);
  });

  it("retries on 529 overloaded_error and 500", async () => {
    const { provider, requests } = makeProvider([
      () => apiErrorResponse(529, "overloaded_error"),
      () => apiErrorResponse(500, "api_error"),
      () => toolUseResponse({ sentiment: "positive", confidence: 0.5 }),
    ]);

    const result = await provider.classify(prompt, schema, opts);
    expect(result.value.sentiment).toBe("positive");
    expect(requests).toHaveLength(3);
  });

  it("does NOT retry a 400 — fails immediately with a typed error", async () => {
    const { provider, requests, sleeps } = makeProvider([
      () => apiErrorResponse(400, "invalid_request_error"),
    ]);

    const error = await provider
      .classify(prompt, schema, opts)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiRequestError);
    expect((error as AiRequestError).status).toBe(400);
    expect((error as AiRequestError).attempts).toBe(1);
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("caps total attempts at 3 and throws AiRequestError with the last status", async () => {
    const { provider, requests, sleeps, logs } = makeProvider([
      () => apiErrorResponse(429, "rate_limit_error"),
      () => apiErrorResponse(529, "overloaded_error"),
      () => apiErrorResponse(429, "rate_limit_error"),
    ]);

    const error = await provider
      .classify(prompt, schema, opts)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiRequestError);
    expect((error as AiRequestError).status).toBe(429);
    expect((error as AiRequestError).attempts).toBe(3);
    expect(requests).toHaveLength(3);
    // Delays grow exponentially: 750ms then 1500ms (random = 0.5).
    expect(sleeps).toEqual([750, 1500]);
    // No response ever arrived → nothing consumed tokens → nothing logged.
    expect(logs).toEqual([]);
  });

  it("logs and throws AiResponseError when the forced tool_use block is missing", async () => {
    const { provider, logs } = makeProvider([() => textOnlyResponse()]);

    await expect(provider.classify(prompt, schema, opts)).rejects.toThrow(
      AiResponseError,
    );
    // The response still cost tokens, so it is logged with the error.
    expect(logs).toHaveLength(1);
    expect(logs[0]?.error).toMatch(/no emit_result tool_use block/);
    expect(logs[0]?.inputTokens).toBe(80);
  });

  it("never fails the call when the cost-log sink throws (best-effort logging)", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const { provider } = makeProvider(
        [() => toolUseResponse({ sentiment: "positive", confidence: 0.9 })],
        {
          logAiCall: async () => {
            throw new Error("db is down");
          },
        },
      );

      const result = await provider.classify(prompt, schema, opts);
      expect(result.value.sentiment).toBe("positive");
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("cost-log sink failed"),
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
