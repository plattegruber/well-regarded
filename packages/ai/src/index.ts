/**
 * @wellregarded/ai — the AI client layer (issue #63, Epic #9).
 *
 * Infrastructure: the `AiProvider` seam, the production
 * `AnthropicProvider` (forced tool-use structured output, zod validation
 * with one feedback retry, backoff on 429/5xx/overloaded, injected cost
 * logging), the deterministic `FakeAiProvider` all tests use, and the
 * embedding seam (`EmbeddingProvider` over Workers AI bge-m3, #71, with
 * `FakeEmbeddingProvider` for tests). Prompts live in src/prompts/ —
 * judgments (#67), excerpts (#69), and safety (#72). The privacy
 * disclosure detector (`checkResponseSafety` / `deterministicSafetyChecks`)
 * lives in src/safety.ts.
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
  type AiConfigEnv,
  BUDGET_SOFT_ALERT_RATIO,
  type BudgetLevel,
  type BudgetState,
  budgetState,
  type PracticeAiSettings,
  practiceAiSettingsSchema,
  type ResolvedAiConfig,
  resolveAiConfig,
} from "./config.js";
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
  estimateCostCents,
  FALLBACK_RATE,
  MODEL_PRICING,
  type ModelRate,
  rateForModel,
} from "./pricing.js";
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
export {
  RESPONSE_DRAFT_MAX_CHARS,
  RESPONSE_DRAFT_PROMPT_NAME,
  RESPONSE_DRAFT_PURPOSE,
  type ResponseDraft,
  type ResponseDraftPromptInput,
  ResponseDraftSchema,
  responseDraftPrompt,
} from "./prompts/response-draft.js";
export {
  SAFETY_LLM_CATEGORIES,
  SAFETY_PROMPT_NAME,
  type SafetyJudgment,
  SafetyJudgmentSchema,
  type SafetyLlmCategory,
  type SafetyPromptInput,
  safetyPrompt,
} from "./prompts/safety.js";
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
export {
  checkResponseSafety,
  deterministicSafetyChecks,
  quoteToSpan,
  SAFETY_PURPOSE,
  type SafetyCheckDeps,
} from "./safety.js";
export {
  type ReviewContext,
  SAFETY_REASON_CODES,
  type SafetyFinding,
  type SafetyFindingLevel,
  type SafetyLevel,
  type SafetyReasonCode,
  type SafetyResult,
  type SafetyRule,
} from "./safety-types.js";
export {
  CARE_CONTEXT_TERMS,
  INSURANCE_CARRIERS,
  INSURANCE_TERMS,
  PROCEDURE_TERMS,
} from "./safety-vocab.js";
export { zodToToolInputSchema } from "./toolSchema.js";
export {
  keywordUrgencyDerivation,
  matchUrgentKeywords,
  URGENT_KEYWORD_CONFIDENCE,
  URGENT_KEYWORD_MODEL_VERSION,
  URGENT_KEYWORDS,
} from "./urgent-keywords.js";
