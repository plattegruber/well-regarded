/**
 * AI config resolution (issue #75, Epic #9): env defaults → per-practice
 * overrides, as one pure function.
 *
 * Env owns the deployment-wide defaults (`PIPELINE_MODEL` /
 * `DRAFTING_MODEL` from #63, plus #75's `AI_DISABLED` kill switch and
 * `AI_MONTHLY_BUDGET_CENTS` default cap); `practice_settings.ai`
 * (packages/db) carries the per-practice overrides. Precedence is
 * env < practice for models and the budget; the DISABLED flag is an OR —
 * either the operator (env) or the practice can switch AI off, and
 * neither can switch the other back on.
 *
 * Budget state (`budgetState`) is the 80/100 policy from the issue:
 * `soft` at ≥ 80% (log + banner, no behavior change), `exhausted` at
 * ≥ 100% (classification defers exactly like the kill switch, with the
 * urgent-keyword fallback keeping routing sighted — see
 * ./urgent-keywords.ts). No budget configured = no cap: `ok` forever.
 */

import { z } from "zod";

import type { ModelConfig } from "./models.js";

/**
 * The `practice_settings.ai` jsonb, validated on read. `.catch(...)`
 * posture: a malformed blob must degrade to defaults, never take the
 * pipeline down — writes go through the settings action which validates
 * strictly, so anything unparseable here is manual meddling.
 */
export const practiceAiSettingsSchema = z
  .object({
    disabled: z.boolean().optional(),
    models: z
      .object({
        pipeline: z.string().min(1).optional(),
        drafting: z.string().min(1).optional(),
      })
      .optional(),
    monthlyBudgetCents: z.number().int().nonnegative().nullish(),
  })
  .partial();

export type PracticeAiSettings = z.infer<typeof practiceAiSettingsSchema>;

/**
 * The env slice `resolveAiConfig` consumes — the `aiEnvSchema` fragment in
 * `packages/core/src/env.ts` (validated there; this type keeps the ai
 * package dependency-free of core).
 */
export interface AiConfigEnv {
  /** Global kill switch: `"true"`/`"1"` disables AI everywhere. */
  AI_DISABLED?: string | undefined;
  PIPELINE_MODEL: string;
  DRAFTING_MODEL: string;
  /** Deployment-default monthly cap in cents; unset = no cap. */
  AI_MONTHLY_BUDGET_CENTS?: number | undefined;
}

export interface ResolvedAiConfig {
  /** env `AI_DISABLED` OR practice `ai.disabled` — the kill switch. */
  disabled: boolean;
  /** Concrete model ids per logical lane, practice override applied. */
  models: ModelConfig;
  /** Monthly cap in cents; null = no cap configured anywhere. */
  monthlyBudgetCents: number | null;
}

/** Truthiness the env flag accepts — boring on purpose. */
function envFlag(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

/**
 * Pure resolution: env defaults → per-practice overrides (issue #75
 * requirement 1). `settings` is the parsed `practice_settings.ai` jsonb,
 * or null when the practice has no settings row.
 */
export function resolveAiConfig(
  env: AiConfigEnv,
  settings: PracticeAiSettings | null,
): ResolvedAiConfig {
  return {
    disabled: envFlag(env.AI_DISABLED) || settings?.disabled === true,
    models: {
      pipeline: settings?.models?.pipeline ?? env.PIPELINE_MODEL,
      drafting: settings?.models?.drafting ?? env.DRAFTING_MODEL,
    },
    monthlyBudgetCents:
      settings?.monthlyBudgetCents ?? env.AI_MONTHLY_BUDGET_CENTS ?? null,
  };
}

/** Soft-alert threshold (issue #75 requirement 3): 80% of the cap. */
export const BUDGET_SOFT_ALERT_RATIO = 0.8;

export type BudgetLevel = "ok" | "soft" | "exhausted";

export interface BudgetState {
  level: BudgetLevel;
  /** spent / budget, 0 when no cap is configured. */
  ratio: number;
}

/**
 * The 80/100 policy, pure and boundary-exact: `soft` at ratio ≥ 0.8,
 * `exhausted` at ratio ≥ 1.0. `budgetCents` null (no cap) or ≤ 0 (a cap
 * of zero means "never call") are handled explicitly: null is `ok`
 * forever, zero is `exhausted` immediately.
 */
export function budgetState(
  spentCents: number,
  budgetCents: number | null,
): BudgetState {
  if (budgetCents === null) return { level: "ok", ratio: 0 };
  if (budgetCents <= 0) return { level: "exhausted", ratio: 1 };
  const ratio = spentCents / budgetCents;
  if (ratio >= 1) return { level: "exhausted", ratio };
  if (ratio >= BUDGET_SOFT_ALERT_RATIO) return { level: "soft", ratio };
  return { level: "ok", ratio };
}
