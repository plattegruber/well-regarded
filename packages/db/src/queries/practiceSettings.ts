/**
 * `practice_settings` reads and the audited write path (issue #75,
 * Epic #9).
 *
 * The AI settings jsonb is validated on read with
 * `practiceAiSettingsSchema` from `@wellregarded/ai`: a malformed blob
 * degrades to "no overrides" (env defaults) instead of taking a consumer
 * down — strict validation happens at write time, in
 * {@link updatePracticeAiSettings}, which is the ONLY sanctioned write
 * path: upsert + `audit_log` row in one transaction, so every kill-switch
 * flip and budget change is attributable (#75 requirement 6).
 */

import {
  type PracticeAiSettings,
  practiceAiSettingsSchema,
} from "@wellregarded/ai";
import type { Actor } from "@wellregarded/core";
import { eq, sql } from "drizzle-orm";

import { audit, type Tx } from "../audit.js";
import type { Db } from "../client.js";
import { practiceSettings } from "../schema/practiceSettings.js";

/** A `practice_settings` row. */
export type PracticeSettings = typeof practiceSettings.$inferSelect;

/**
 * The practice's AI settings, parsed — `null` when the practice has no
 * settings row, no `ai` blob, or an unparseable one (degrade to env
 * defaults, never throw: the pipeline reads this per message).
 */
export async function getPracticeAiSettings(
  db: Db | Tx,
  practiceId: string,
): Promise<PracticeAiSettings | null> {
  const rows = await db
    .select({ ai: practiceSettings.ai })
    .from(practiceSettings)
    .where(eq(practiceSettings.practiceId, practiceId))
    .limit(1);
  const blob = rows[0]?.ai;
  if (!blob) return null;
  const parsed = practiceAiSettingsSchema.safeParse(blob);
  return parsed.success ? parsed.data : null;
}

export interface UpdatePracticeAiSettingsInput {
  practiceId: string;
  /** The full new `ai` blob (validated here; not a partial patch). */
  settings: PracticeAiSettings;
  /** Who changed it — audited in the same transaction. */
  actor: Actor;
}

/**
 * The one write path for `practice_settings.ai`: validate, upsert, and
 * audit (`practice.ai_settings_updated`, with before/after — settings are
 * config, not PII) atomically. Returns the stored settings.
 */
export async function updatePracticeAiSettings(
  db: Db,
  input: UpdatePracticeAiSettingsInput,
): Promise<PracticeAiSettings> {
  const settings = practiceAiSettingsSchema.parse(input.settings);
  return db.transaction(async (tx) => {
    const beforeRows = await tx
      .select({ ai: practiceSettings.ai })
      .from(practiceSettings)
      .where(eq(practiceSettings.practiceId, input.practiceId))
      .limit(1);
    const before = beforeRows[0]?.ai ?? null;

    await tx
      .insert(practiceSettings)
      .values({ practiceId: input.practiceId, ai: settings })
      .onConflictDoUpdate({
        target: practiceSettings.practiceId,
        set: { ai: settings, updatedAt: sql`now()` },
      });

    await audit(tx, {
      practiceId: input.practiceId,
      actor: input.actor,
      action: "practice.ai_settings_updated",
      entityType: "practice_settings",
      entityId: input.practiceId,
      payload: { before, after: settings },
    });
    return settings;
  });
}
