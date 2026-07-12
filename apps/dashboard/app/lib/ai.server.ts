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
  type AiConfigEnv,
  type AiProvider,
  AiRequestError,
  AnthropicProvider,
} from "@wellregarded/ai";
import { createAiCallSink, type Db, practiceAiStatus } from "@wellregarded/db";

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
 * The `AiConfigEnv` slice off the raw worker env (issue #75) — what
 * `resolveAiConfig` / `practiceAiStatus` consume. Defaults mirror
 * `aiEnvSchema` in @wellregarded/core.
 */
export function aiConfigEnv(env: unknown): AiConfigEnv {
  const budget = envString(env, "AI_MONTHLY_BUDGET_CENTS");
  return {
    AI_DISABLED: envString(env, "AI_DISABLED"),
    PIPELINE_MODEL: envString(env, "PIPELINE_MODEL") ?? DEFAULT_PIPELINE_MODEL,
    DRAFTING_MODEL: envString(env, "DRAFTING_MODEL") ?? DEFAULT_DRAFTING_MODEL,
    AI_MONTHLY_BUDGET_CENTS:
      budget !== undefined && Number.isFinite(Number(budget))
        ? Number(budget)
        : undefined,
  };
}

/**
 * The provider for one request. `db` feeds the `ai_calls` cost sink so
 * dashboard-originated safety checks are billed/logged like every other
 * AI call.
 *
 * `gate` (issue #75): when a practice id is given, every `classify` first
 * resolves the practice's kill switch + monthly budget through
 * `practiceAiStatus` and rejects with a clear `AiRequestError` when AI is
 * disabled or the cap is reached — `checkResponseSafety` catches it and
 * degrades honestly to deterministic-only mode (`ai_check_skipped`
 * notice); a future composer drafting call surfaces the same message as
 * its "AI budget reached" error. Approval is never waved through
 * unchecked, and never silently un-gated.
 */
export function getAiProvider(
  env: unknown,
  db: Db,
  gate?: { practiceId: string },
): AiProvider {
  const provider = buildProvider(env, db);
  if (!gate) return provider;
  return {
    async classify(prompt, schema, opts) {
      const status = await practiceAiStatus(db, {
        practiceId: gate.practiceId,
        env: aiConfigEnv(env),
      });
      if (status.config.disabled) {
        throw new AiRequestError(
          "AI is currently disabled for this practice — checks run in " +
            "degraded (deterministic-only) mode.",
          { attempts: 0 },
        );
      }
      if (status.budget.level === "exhausted") {
        throw new AiRequestError(
          "AI budget reached for this month — AI checks and drafting are " +
            "paused until the budget resets or is raised in Settings → AI.",
          { attempts: 0 },
        );
      }
      return provider.classify(prompt, schema, opts);
    },
  };
}

function buildProvider(env: unknown, db: Db): AiProvider {
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
