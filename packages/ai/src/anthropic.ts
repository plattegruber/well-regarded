/**
 * `AnthropicProvider` — the production `AiProvider` (issue #63).
 *
 * Wraps `@anthropic-ai/sdk` (fetch transport — works on Cloudflare
 * Workers; no Node-only transport is pulled in) with:
 *
 * - **Forced structured output via tool use**: one tool (`emit_result`)
 *   whose `input_schema` comes from the caller's zod schema, with
 *   `tool_choice: {type: "tool"}` so the model must emit conforming JSON.
 *   We read `content[].input` from the tool_use block — never free text.
 * - **Validation retry**: tool input is parsed with the zod schema; on
 *   mismatch we retry ONCE with the validation error appended to the
 *   prompt, then throw `AiValidationError`.
 * - **Transport retries**: exponential backoff + equal jitter on 429, 5xx
 *   (which includes 529 `overloaded_error`), and connection errors — max
 *   3 attempts per request, base delay 1s. 400s never retry.
 * - **Cost logging**: one `AiCallRecord` per API *response* (successes AND
 *   failed-validation calls — they cost money too) through the injected
 *   sink. Requests that never produced a response (rate-limited away,
 *   connection failures) consumed no tokens and are not logged. The sink
 *   is best-effort: its failures are console-logged, never thrown.
 *
 * The SDK's own retry loop is disabled (`maxRetries: 0`) so this class is
 * the single owner of retry policy and tests can drive it
 * deterministically via the injectable `sleep`/`random`/`fetch` seams.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

import {
  backoffDelayMs,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_DELAY_MS,
  isRetryableStatus,
} from "./backoff.js";
import {
  AiRequestError,
  AiResponseError,
  AiValidationError,
} from "./errors.js";
import { type ModelConfig, resolveModel } from "./models.js";
import type {
  AiCallSink,
  AiProvider,
  AiResult,
  ClassifyOpts,
  ClassifyPrompt,
} from "./provider.js";
import { zodToToolInputSchema } from "./toolSchema.js";

/** Name of the single forced tool. */
export const RESULT_TOOL_NAME = "emit_result";

const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

export interface AnthropicProviderOptions {
  /** `ANTHROPIC_API_KEY` from Worker secrets (see docs/secrets.md). */
  apiKey: string;
  /** Concrete model ids from validated env (PIPELINE_MODEL / DRAFTING_MODEL). */
  models: ModelConfig;
  /**
   * Cost-log sink — `createAiCallSink(db)` from `@wellregarded/db` in
   * production. Optional so the provider stays constructible without a DB
   * (e.g. one-off scripts), but workers should always pass it.
   */
  logAiCall?: AiCallSink;
  /** Max attempts per API request (default 3). */
  maxAttempts?: number;
  /** Base backoff delay in ms (default 1000). */
  baseDelayMs?: number;
  /** Backoff cap in ms (default 30000). */
  maxDelayMs?: number;
  /** Default output-token cap when `ClassifyOpts.maxOutputTokens` is unset. */
  maxOutputTokens?: number;
  /**
   * Injectable seams for tests. `sleep` defaults to a real setTimeout
   * wait (fine in queue consumers, per the issue notes); `random` feeds
   * the jitter; `fetch` overrides the SDK transport.
   */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  fetch?: typeof globalThis.fetch;
  /** Override the API base URL (test servers). */
  baseURL?: string;
}

interface ApiCallOutcome {
  message: Anthropic.Message;
  latencyMs: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Compact one zod error into a single line the model (and a log row) can use. */
function describeZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".") || "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export class AnthropicProvider implements AiProvider {
  readonly #client: Anthropic;
  readonly #models: ModelConfig;
  readonly #logAiCall: AiCallSink | undefined;
  readonly #maxAttempts: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #maxOutputTokens: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;

  constructor(options: AnthropicProviderOptions) {
    this.#client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      fetch: options.fetch,
      // This class owns retries; the SDK must not add its own.
      maxRetries: 0,
    });
    this.#models = options.models;
    this.#logAiCall = options.logAiCall;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.#maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.#maxOutputTokens =
      options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  async classify<T>(
    prompt: ClassifyPrompt,
    schema: z.ZodType<T>,
    opts: ClassifyOpts,
  ): Promise<AiResult<T>> {
    const model = resolveModel(opts.model ?? "pipeline", this.#models);
    const tool: Anthropic.Tool = {
      name: RESULT_TOOL_NAME,
      description:
        "Report the classification result. Always call this tool exactly once with the full result.",
      input_schema: zodToToolInputSchema(schema) as Anthropic.Tool.InputSchema,
    };

    const first = await this.#requestWithRetries(model, prompt, tool, opts);
    const firstInput = await this.#extractToolInput(first, model, opts);
    const firstParse = schema.safeParse(firstInput);
    if (firstParse.success) {
      const usage = this.#usageOf(first, model);
      await this.#log(opts, usage, null);
      return { value: firstParse.data, usage };
    }

    // Validation retry (once): feed the zod error back to the model.
    const firstIssues = describeZodIssues(firstParse.error);
    await this.#log(
      opts,
      this.#usageOf(first, model),
      `schema validation failed: ${firstIssues}`,
    );

    const retryPrompt: ClassifyPrompt = {
      ...prompt,
      user:
        `${prompt.user}\n\n` +
        `Your previous output failed validation: ${firstIssues}\n` +
        `Call ${RESULT_TOOL_NAME} again with input that conforms to the schema exactly.`,
    };
    const second = await this.#requestWithRetries(
      model,
      retryPrompt,
      tool,
      opts,
    );
    const secondInput = await this.#extractToolInput(second, model, opts);
    const secondParse = schema.safeParse(secondInput);
    if (secondParse.success) {
      const usage = this.#usageOf(second, model);
      await this.#log(opts, usage, null);
      return { value: secondParse.data, usage };
    }

    const secondIssues = describeZodIssues(secondParse.error);
    await this.#log(
      opts,
      this.#usageOf(second, model),
      `schema validation failed (retry): ${secondIssues}`,
    );
    throw new AiValidationError({
      promptName: prompt.name,
      purpose: opts.purpose,
      issues: secondIssues,
    });
  }

  /** One API request with transport retries. Throws `AiRequestError` when exhausted. */
  async #requestWithRetries(
    model: string,
    prompt: ClassifyPrompt,
    tool: Anthropic.Tool,
    opts: ClassifyOpts,
  ): Promise<ApiCallOutcome> {
    for (let attempt = 1; ; attempt++) {
      const startedAt = Date.now();
      try {
        const message = await this.#client.messages.create({
          model,
          max_tokens: opts.maxOutputTokens ?? this.#maxOutputTokens,
          ...(prompt.system === undefined ? {} : { system: prompt.system }),
          messages: [{ role: "user", content: prompt.user }],
          tools: [tool],
          tool_choice: {
            type: "tool",
            name: RESULT_TOOL_NAME,
            disable_parallel_tool_use: true,
          },
        });
        return { message, latencyMs: Date.now() - startedAt };
      } catch (error) {
        if (!isRetryableError(error) || attempt >= this.#maxAttempts) {
          if (error instanceof Anthropic.APIError) {
            throw new AiRequestError(
              `Anthropic request failed (${error.status ?? "connection error"}) after ${attempt} attempt(s): ${error.message}`,
              { status: error.status, attempts: attempt, cause: error },
            );
          }
          throw error;
        }
        await this.#sleep(
          backoffDelayMs(attempt, {
            baseDelayMs: this.#baseDelayMs,
            maxDelayMs: this.#maxDelayMs,
            random: this.#random,
          }),
        );
      }
    }
  }

  /**
   * Pull the forced tool_use input out of a response. A response without
   * it (safety refusal, max_tokens truncation) still cost tokens, so it
   * is logged before the typed throw.
   */
  async #extractToolInput(
    outcome: ApiCallOutcome,
    model: string,
    opts: ClassifyOpts,
  ): Promise<unknown> {
    const block = outcome.message.content.find(
      (candidate): candidate is Anthropic.ToolUseBlock =>
        candidate.type === "tool_use" && candidate.name === RESULT_TOOL_NAME,
    );
    if (block) return block.input;

    const stopReason = outcome.message.stop_reason ?? null;
    await this.#log(
      opts,
      this.#usageOf(outcome, model),
      `no ${RESULT_TOOL_NAME} tool_use block in response (stop_reason: ${stopReason ?? "unknown"})`,
    );
    throw new AiResponseError(
      `Anthropic response contained no ${RESULT_TOOL_NAME} tool_use block despite forced tool_choice (stop_reason: ${stopReason ?? "unknown"})`,
      { stopReason },
    );
  }

  #usageOf(outcome: ApiCallOutcome, model: string) {
    return {
      model,
      inputTokens: outcome.message.usage.input_tokens,
      outputTokens: outcome.message.usage.output_tokens,
      latencyMs: outcome.latencyMs,
    };
  }

  /** Best-effort cost logging — must never fail the user-facing call. */
  async #log(
    opts: ClassifyOpts,
    usage: {
      model: string;
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
    },
    error: string | null,
  ): Promise<void> {
    if (!this.#logAiCall) return;
    try {
      await this.#logAiCall({
        practiceId: opts.practiceId,
        purpose: opts.purpose,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs: usage.latencyMs,
        error,
      });
    } catch (sinkError) {
      console.error(
        "[@wellregarded/ai] ai_calls cost-log sink failed",
        sinkError,
      );
    }
  }
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.APIError) {
    return typeof error.status === "number"
      ? isRetryableStatus(error.status)
      : true;
  }
  return false;
}
