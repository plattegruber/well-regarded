/**
 * The AI seam (issue #63, Epic #9).
 *
 * `AiProvider` is the ONE interface every AI consumer in the repo depends
 * on — the pipeline classify stage (#67), excerpt extraction (#69),
 * response drafting, privacy checking, and the eval harness (#73) all take
 * an `AiProvider`, never the Anthropic SDK directly. Production code wires
 * in `AnthropicProvider` (./anthropic.ts); every test wires in
 * `FakeAiProvider` (./fake.ts). If a module imports `@anthropic-ai/sdk`
 * outside this package, that is a bug.
 *
 * Layering for cost logging
 * -------------------------
 * This package stays DB-free: it defines the `AiCallRecord` shape and the
 * `AiCallSink` function type, and `AnthropicProvider` calls an *injected*
 * sink after every API response. `packages/db` provides the concrete sink
 * (`logAiCall` / `createAiCallSink` writing to the `ai_calls` table) and
 * imports these types from here — the dependency arrow is db → ai, never
 * ai → db.
 */

import type { z } from "zod";

/**
 * A prompt handed to `classify`. Prompt *text* does not live in this
 * package (that's #67/#69/#72); this is only the shape those issues will
 * produce.
 */
export interface ClassifyPrompt {
  /**
   * Stable identifier for the prompt (e.g. `"judgments/v1"`). This is the
   * key `FakeAiProvider` fixtures are registered under, so it must be
   * deterministic — never interpolate per-call data into it.
   */
  name: string;
  /** Optional system prompt. */
  system?: string;
  /** The user-turn content. */
  user: string;
}

/**
 * Logical model names. Callers never hardcode a concrete model id — they
 * pick a lane, and the concrete id comes from env (`PIPELINE_MODEL` /
 * `DRAFTING_MODEL`, validated in `packages/core/src/env.ts`) at call time.
 */
export type LogicalModel = "pipeline" | "drafting";

export interface ClassifyOpts {
  /** Tag for cost logging, e.g. `"judgments"` or `"excerpts"`. */
  purpose: string;
  /** Tenant the call is billed against; null for tenant-less calls (evals, backfills). */
  practiceId: string | null;
  /** Logical model lane; defaults to `"pipeline"`. */
  model?: LogicalModel;
  /** Cap on output tokens for this call (defaults to the provider's). */
  maxOutputTokens?: number;
  /**
   * Trace id propagated from the caller's execution context (issue #64,
   * e.g. the pipeline message's `requestId`), so provider log lines join
   * the signal's journey. Optional: tenant-less/offline callers omit it.
   */
  requestId?: string | undefined;
}

/** Usage metadata carried alongside every parsed result. */
export interface AiUsage {
  /** Concrete model id that served the call (e.g. `claude-haiku-4-5-20251001`). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface AiResult<T> {
  value: T;
  usage: AiUsage;
}

/**
 * The provider seam. `classify` forces structured output conforming to
 * `schema` and returns the zod-parsed value plus usage metadata.
 */
export interface AiProvider {
  classify<T>(
    prompt: ClassifyPrompt,
    schema: z.ZodType<T>,
    opts: ClassifyOpts,
  ): Promise<AiResult<T>>;
}

/**
 * One row of AI cost accounting — matches the `ai_calls` table in
 * `packages/db` column-for-column (minus the DB-generated `id` and
 * `created_at`). `error` is null for a clean call and a short description
 * for calls that returned a response but failed downstream (zod validation
 * mismatch, missing tool_use block): those calls cost money too, so they
 * are logged.
 */
export interface AiCallRecord {
  practiceId: string | null;
  purpose: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error: string | null;
}

/**
 * Injected cost-log sink. `packages/db` exports `createAiCallSink(db)`
 * which returns one of these; workers construct their provider with it.
 * Providers must treat the sink as best-effort — a sink failure must never
 * fail the user-facing call.
 */
export type AiCallSink = (record: AiCallRecord) => Promise<void>;
