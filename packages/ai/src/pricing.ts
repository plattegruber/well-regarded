/**
 * Static per-model token pricing (issue #75, Epic #9) — the budget cap's
 * cost model over `ai_calls` token counts.
 *
 * THESE ARE ESTIMATES. The table is a hand-maintained snapshot of list
 * prices, matched by model-id prefix so dated ids
 * (`claude-haiku-4-5-20251001`) share their family's rate. It exists so
 * the monthly cap has a deterministic, offline number to compare against —
 * not to reconcile invoices. When Anthropic pricing changes, update the
 * table; historical spend is deliberately re-priced at the current rates
 * (the cap protects this month's wallet, not the ledger).
 *
 * Unknown models fall back to the most expensive known rate: a cap must
 * fail toward "we probably spent more", never silently under-count.
 */

/** Cents per **million** tokens, input/output. */
export interface ModelRate {
  inputCentsPerMTok: number;
  outputCentsPerMTok: number;
}

/**
 * Longest-prefix-match table. Keep entries ordered longest-first within a
 * family so the more specific id wins (matching walks the whole table and
 * prefers the longest matching prefix regardless of order, but readers
 * scan top-down).
 */
export const MODEL_PRICING: Record<string, ModelRate> = {
  // Haiku 4.5 — $1 / $5 per MTok.
  "claude-haiku-4-5": { inputCentsPerMTok: 100, outputCentsPerMTok: 500 },
  // Sonnet 4.5 / 5 families — $3 / $15 per MTok.
  "claude-sonnet-4": { inputCentsPerMTok: 300, outputCentsPerMTok: 1500 },
  "claude-sonnet-5": { inputCentsPerMTok: 300, outputCentsPerMTok: 1500 },
  // Opus 4.x — $5 / $25 per MTok (post-2025 repricing).
  "claude-opus-4": { inputCentsPerMTok: 500, outputCentsPerMTok: 2500 },
};

/** The pessimistic fallback for model ids the table does not know. */
export const FALLBACK_RATE: ModelRate = {
  inputCentsPerMTok: 500,
  outputCentsPerMTok: 2500,
};

/** Longest matching prefix rate, or the pessimistic fallback. */
export function rateForModel(model: string): ModelRate {
  let best: { prefix: string; rate: ModelRate } | undefined;
  for (const [prefix, rate] of Object.entries(MODEL_PRICING)) {
    if (
      model.startsWith(prefix) &&
      (best === undefined || prefix.length > best.prefix.length)
    ) {
      best = { prefix, rate };
    }
  }
  return best?.rate ?? FALLBACK_RATE;
}

/**
 * Estimated cost of one call in cents (fractional — callers sum first,
 * round last, so a month of tiny calls does not round to zero repeatedly).
 */
export function estimateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rate = rateForModel(model);
  return (
    (inputTokens * rate.inputCentsPerMTok +
      outputTokens * rate.outputCentsPerMTok) /
    1_000_000
  );
}
