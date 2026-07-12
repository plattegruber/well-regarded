// The dashboard's AI provider seam (issues #80/#79): server-side
// `checkResponseSafety` calls — the approve-time re-run today, the
// composer's debounced full check when #79 lands — construct their
// provider here, never from `@anthropic-ai/sdk` directly.
//
// Degraded mode is a feature, not an error: without ANTHROPIC_API_KEY the
// returned provider throws `AiRequestError` from `classify`, which
// `checkResponseSafety` catches — deterministic findings still apply and
// an info-level `ai_check_skipped` notice surfaces the degraded mode
// honestly (issue #72's contract). Approval is NEVER waved through
// unchecked; it just runs on Layer 1 alone.
import {
  type AiProvider,
  AiRequestError,
  AnthropicProvider,
} from "@wellregarded/ai";
import { createAiCallSink, type Db } from "@wellregarded/db";

/** Read a string var/secret off the raw worker env. Secrets (the API key)
 * are absent from the generated `Env` type, hence the untyped read. */
function envString(env: unknown, key: string): string | undefined {
  const value = (env as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Defaults mirror `aiEnvSchema` in @wellregarded/core (single source of
 * truth there; these are the fallbacks for the structural slice). */
const DEFAULT_PIPELINE_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_DRAFTING_MODEL = "claude-sonnet-5";

/**
 * The provider for one request. `db` feeds the `ai_calls` cost sink so
 * dashboard-originated safety checks are billed/logged like every other
 * AI call.
 */
export function getAiProvider(env: unknown, db: Db): AiProvider {
  const apiKey = envString(env, "ANTHROPIC_API_KEY");
  if (!apiKey) {
    return {
      classify() {
        // Caught by checkResponseSafety → degraded mode with the
        // ai_check_skipped notice; other callers surface it inline.
        return Promise.reject(
          new AiRequestError(
            "ANTHROPIC_API_KEY is not configured — AI checks run in " +
              "degraded (deterministic-only) mode.",
            { attempts: 0 },
          ),
        );
      },
    };
  }
  return new AnthropicProvider({
    apiKey,
    models: {
      pipeline: envString(env, "PIPELINE_MODEL") ?? DEFAULT_PIPELINE_MODEL,
      drafting: envString(env, "DRAFTING_MODEL") ?? DEFAULT_DRAFTING_MODEL,
    },
    logAiCall: createAiCallSink(db),
  });
}
