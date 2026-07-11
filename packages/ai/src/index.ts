/**
 * @wellregarded/ai — the AI client layer (issue #63, Epic #9).
 *
 * Pure infrastructure: the `AiProvider` seam, the production
 * `AnthropicProvider` (forced tool-use structured output, zod validation
 * with one feedback retry, backoff on 429/5xx/overloaded, injected cost
 * logging), and the deterministic `FakeAiProvider` all tests use. NO
 * prompt text lives here — prompts land in #67 (judgments), #69
 * (excerpts), and #72 (safety).
 */

export {
  AnthropicProvider,
  type AnthropicProviderOptions,
  RESULT_TOOL_NAME,
} from "./anthropic.js";
export {
  type BackoffOptions,
  backoffDelayMs,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_DELAY_MS,
  isRetryableStatus,
} from "./backoff.js";
export {
  AiError,
  AiRequestError,
  AiResponseError,
  AiValidationError,
} from "./errors.js";
export {
  type FakeAiCall,
  FakeAiProvider,
  FakeAiProviderError,
} from "./fake.js";
export { type ModelConfig, resolveModel } from "./models.js";
export type {
  AiCallRecord,
  AiCallSink,
  AiProvider,
  AiResult,
  AiUsage,
  ClassifyOpts,
  ClassifyPrompt,
  LogicalModel,
} from "./provider.js";
export { zodToToolInputSchema } from "./toolSchema.js";
