/**
 * @wellregarded/ai — the AI client layer (issue #63, Epic #9).
 *
 * Infrastructure: the `AiProvider` seam, the production
 * `AnthropicProvider` (forced tool-use structured output, zod validation
 * with one feedback retry, backoff on 429/5xx/overloaded, injected cost
 * logging), the deterministic `FakeAiProvider` all tests use, and the
 * embedding seam (`EmbeddingProvider` over Workers AI bge-m3, #71, with
 * `FakeEmbeddingProvider` for tests). Prompts live in src/prompts/ —
 * judgments (#67) and excerpts (#69) are here; safety (#72) follows.
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
  BGE_M3_EMBEDDING_MODEL,
  createWorkersAiEmbedder,
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIMENSIONS,
  EmbeddingDimensionError,
  type EmbeddingProvider,
  FAKE_EMBEDDING_MODEL,
  FakeEmbeddingProvider,
  type FakeEmbeddingProviderOptions,
  fakeEmbed,
  type WorkersAiBinding,
  type WorkersAiEmbedderOptions,
} from "./embedding.js";
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
export {
  countWords,
  EXCERPT_MIN_MODEL_WORDS,
  EXCERPTS_PROMPT_NAME,
  type Excerpts,
  type ExcerptsPromptInput,
  ExcerptsSchema,
  type ExcerptValidation,
  excerptsPrompt,
  excerptsRetryPrompt,
  locateExcerpt,
  type PlannedExcerpt,
  validateExcerpts,
  wholeTextExcerpt,
} from "./prompts/excerpts.js";
export {
  applyUrgencyFloor,
  hasClassifiableText,
  JUDGMENTS_PROMPT_NAME,
  type JudgmentDerivation,
  type Judgments,
  type JudgmentsPromptInput,
  JudgmentsSchema,
  judgmentsPrompt,
  judgmentsToDerivations,
  RATING_ONLY_CONFIDENCE,
  ratingOnlyDerivations,
  sentimentFromRating,
  URGENCY_CONFIDENCE_FLOOR,
} from "./prompts/judgments.js";
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
