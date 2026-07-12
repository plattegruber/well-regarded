/**
 * Monthly AI spend + the practice AI status helper (issue #75, Epic #9).
 *
 * Spend = SUM over this calendar month's `ai_calls` rows for the practice
 * (error rows included — failed validation retries cost money too),
 * priced through the static estimate table in `@wellregarded/ai`
 * (`estimateCostCents`; approximate by design, see its module doc).
 *
 * **Month boundary**: the practice's own timezone (`practices.timezone`,
 * which Epic #4's schema stores) — "this month's budget" should reset at
 * the practice's midnight, not UTC's. The same choice #86's response
 * metrics make; change both together.
 *
 * `practiceAiStatus` is the one status read every consumer shares: the
 * classify stage's gate, the settings page's banner, and the Today card
 * all resolve config + spend through it. One indexed SUM per call is fine
 * at M1 volume (`ai_calls_practice_id_created_at_idx` serves it); the
 * future caching hook, when a hot pipeline makes this hurt, is memoizing
 * the (practiceId, month) sum with a short TTL in the caller — do not
 * cache here, correctness at the 100% boundary matters more than a query.
 */

import {
  type AiConfigEnv,
  type BudgetState,
  budgetState,
  estimateCostCents,
  type PracticeAiSettings,
  type ResolvedAiConfig,
  resolveAiConfig,
} from "@wellregarded/ai";
import { sql } from "drizzle-orm";

import type { Tx } from "../audit.js";
import type { Db } from "../client.js";
import { aiCalls } from "../schema/aiCalls.js";
import { practices } from "../schema/tenancy.js";
import { getPracticeAiSettings } from "./practiceSettings.js";

/**
 * Estimated spend (cents, rounded to integer at the end — summed
 * fractionally per model first) for the practice's current calendar month
 * in its own timezone, as of `now`.
 */
export async function monthlyAiSpendCents(
  db: Db | Tx,
  params: { practiceId: string; now?: Date },
): Promise<number> {
  const now = params.now ?? new Date();
  // Per-model token sums this month; month start computed in the
  // practice's timezone and converted back to an instant. Everything is
  // one indexed scan of ai_calls (see the module doc's caching note).
  const rows = await db
    .select({
      model: aiCalls.model,
      inputTokens: sql<string>`sum(${aiCalls.inputTokens})`,
      outputTokens: sql<string>`sum(${aiCalls.outputTokens})`,
    })
    .from(aiCalls)
    .innerJoin(practices, sql`${practices.id} = ${aiCalls.practiceId}`)
    .where(
      sql`${aiCalls.practiceId} = ${params.practiceId}
        AND ${aiCalls.createdAt} >= (date_trunc('month', ${now.toISOString()}::timestamptz AT TIME ZONE ${practices.timezone}) AT TIME ZONE ${practices.timezone})
        AND ${aiCalls.createdAt} <= ${now.toISOString()}::timestamptz`,
    )
    .groupBy(aiCalls.model);

  const total = rows.reduce(
    (cents, row) =>
      cents +
      estimateCostCents(
        row.model,
        Number(row.inputTokens),
        Number(row.outputTokens),
      ),
    0,
  );
  return Math.round(total);
}

/** Everything a consumer needs to decide "may I call the model?". */
export interface PracticeAiStatus {
  /** env → practice resolution (`resolveAiConfig`). */
  config: ResolvedAiConfig;
  /** The raw practice overrides, for settings UIs. Null = no overrides. */
  settings: PracticeAiSettings | null;
  /** Estimated spend this month, cents. */
  spentCents: number;
  /** 80/100 policy state against `config.monthlyBudgetCents`. */
  budget: BudgetState;
}

/**
 * The `practice_ai_status` read (issue #75 requirement 3): settings +
 * month spend + resolved config in one call. Consumers: the classify
 * stage's per-message gate, the dashboard's Today budget card, and the
 * settings page banner.
 */
export async function practiceAiStatus(
  db: Db,
  params: { practiceId: string; env: AiConfigEnv; now?: Date },
): Promise<PracticeAiStatus> {
  const settings = await getPracticeAiSettings(db, params.practiceId);
  const config = resolveAiConfig(params.env, settings);
  // No cap and not disabled → skip the SUM entirely (the common case).
  const spentCents =
    config.monthlyBudgetCents === null
      ? 0
      : await monthlyAiSpendCents(db, {
          practiceId: params.practiceId,
          ...(params.now ? { now: params.now } : {}),
        });
  return {
    config,
    settings,
    spentCents,
    budget: budgetState(spentCents, config.monthlyBudgetCents),
  };
}
