/**
 * Logical → concrete model routing (issue #63).
 *
 * Callers never hardcode model ids: `ClassifyOpts.model` names a lane
 * (`"pipeline"` for high-volume classification, `"drafting"` for
 * quality-sensitive text generation) and the concrete id is resolved at
 * call time from this config. The config values come from env —
 * `PIPELINE_MODEL` (default `claude-haiku-4-5-20251001`) and
 * `DRAFTING_MODEL` (default `claude-sonnet-5`), validated by the `ai`
 * fragment in `packages/core/src/env.ts` (defaults live there, once).
 */

import type { LogicalModel } from "./provider.js";

/** Concrete model ids per logical lane, sourced from validated env. */
export interface ModelConfig {
  /** e.g. `env.PIPELINE_MODEL` — high-volume classification (Haiku-class). */
  pipeline: string;
  /** e.g. `env.DRAFTING_MODEL` — response drafting (Sonnet-class). */
  drafting: string;
}

/** Resolve a logical model name to the concrete id for this deployment. */
export function resolveModel(
  logical: LogicalModel,
  config: ModelConfig,
): string {
  return config[logical];
}
