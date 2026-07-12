/**
 * `practice_settings` — per-practice operational configuration (issue #75,
 * Epic #9; the storage seam Epic #4 anticipated).
 *
 * One row per practice, created lazily on first write. Settings live in
 * namespaced jsonb columns — `ai` today (see `PracticeAiSettings` in
 * `@wellregarded/ai`: model overrides per logical lane, monthly budget
 * cents, disabled flag); later epics add their own columns (#122 proposes
 * recovery due-windows) rather than growing one untyped blob.
 *
 * Written ONLY through `updatePracticeAiSettings` in
 * ../queries/practiceSettings.ts — an upsert plus an `audit_log` row in
 * one transaction, so every config change is attributable (#75
 * requirement 6: no silent degradation, no silent flips).
 */

import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

import { practices } from "./tenancy.js";

/**
 * The `ai` jsonb shape. Declared structurally here (mirroring
 * `PracticeAiSettings` in `@wellregarded/ai`, which owns the zod schema
 * and parses on read) so the schema module stays dependency-light.
 */
export interface PracticeAiSettingsColumn {
  /** Per-practice kill switch — OR'd with the `AI_DISABLED` env flag. */
  disabled?: boolean | undefined;
  /** Concrete model-id overrides per logical lane. */
  models?:
    | { pipeline?: string | undefined; drafting?: string | undefined }
    | undefined;
  /** Monthly AI budget in cents; null/absent = env default (or no cap). */
  monthlyBudgetCents?: number | null | undefined;
}

export const practiceSettings = pgTable("practice_settings", {
  /** One row per practice — the practice id IS the key. */
  practiceId: uuid("practice_id")
    .primaryKey()
    .references(() => practices.id),
  /** AI configuration overrides (issue #75). Null = all env defaults. */
  ai: jsonb("ai").$type<PracticeAiSettingsColumn>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
