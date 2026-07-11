/**
 * `ai_calls` — per-call AI cost accounting (issue #63, Epic #9).
 *
 * One row per Anthropic API *response*: successes AND calls whose output
 * failed schema validation (`error` non-null) — failed validation retries
 * cost money too. Requests that never produced a response (rate-limited
 * away, connection failures) consumed no tokens and write nothing.
 *
 * Written exclusively through `logAiCall` in `../queries/aiCalls.ts`,
 * which `@wellregarded/ai`'s `AnthropicProvider` reaches via an injected
 * sink — the AI package itself never imports this module (layering: the
 * dependency arrow is db → ai, type-only, never ai → db). Logging is
 * best-effort by contract: the provider swallows sink failures, so a
 * broken insert can never fail a user-facing call.
 *
 * Append-only by convention (like `derivations`): rows are cost telemetry,
 * never updated — there is deliberately no `updated_at` column.
 */

import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { practices } from "./tenancy.js";

export const aiCalls = pgTable(
  "ai_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * NULLABLE exception to the everything-carries-practice_id rule:
     * tenant-less calls (eval runs, backfills, smoke tests) have no
     * practice to bill against.
     */
    practiceId: uuid("practice_id").references(() => practices.id),
    /** Cost-attribution tag, e.g. `"judgments"`, `"excerpts"`, `"drafting"`. */
    purpose: text("purpose").notNull(),
    /** Concrete model id that served the call (never the logical lane name). */
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    /**
     * NULL for clean calls; a short description for calls that returned a
     * response but failed downstream (zod validation mismatch, missing
     * tool_use block).
     */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Serves per-practice cost dashboards and retention sweeps.
    index("ai_calls_practice_id_created_at_idx").on(
      table.practiceId,
      table.createdAt.desc(),
    ),
  ],
);
