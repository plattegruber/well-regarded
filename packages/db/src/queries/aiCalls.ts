/**
 * AI cost-log sink (issue #63, Epic #9).
 *
 * The concrete side of the `AiCallSink` seam: `@wellregarded/ai` defines
 * the `AiCallRecord` shape and calls an injected sink after every API
 * response; this module writes those records to `ai_calls`. The import
 * from `@wellregarded/ai` is type-only — the runtime dependency arrow
 * stays db-side (db → ai types, never ai → db).
 *
 * Wiring (in a worker):
 *
 *   const db = createDb(env.HYPERDRIVE.connectionString);
 *   const provider = new AnthropicProvider({
 *     apiKey: env.ANTHROPIC_API_KEY,
 *     models: { pipeline: env.PIPELINE_MODEL, drafting: env.DRAFTING_MODEL },
 *     logAiCall: createAiCallSink(db),
 *   });
 *
 * Best-effort contract: `AnthropicProvider` try/catches the sink, so a
 * failed insert is console-logged and never fails the user-facing call.
 */

import type { AiCallRecord, AiCallSink } from "@wellregarded/ai";

import type { Db } from "../client.js";
import { aiCalls } from "../schema/aiCalls.js";

/** An `ai_calls` row. */
export type AiCall = typeof aiCalls.$inferSelect;

/** Insert one cost-log row. See the module docs for the wiring idiom. */
export async function logAiCall(db: Db, record: AiCallRecord): Promise<void> {
  await db.insert(aiCalls).values({
    practiceId: record.practiceId,
    purpose: record.purpose,
    model: record.model,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    latencyMs: record.latencyMs,
    error: record.error,
  });
}

/** Bind `logAiCall` to a client, yielding the sink `AnthropicProvider` takes. */
export function createAiCallSink(db: Db): AiCallSink {
  return (record) => logAiCall(db, record);
}
