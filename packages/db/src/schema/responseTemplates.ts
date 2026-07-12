/**
 * `response_templates` — reusable reply shapes for the composer (issue
 * #83, Epic #10).
 *
 * One row per practice-scoped template. `body` may contain ONLY the
 * whitelisted placeholders from `@wellregarded/core`
 * (`TEMPLATE_PLACEHOLDERS`: `{reviewer_name}` / `{practice_name}`) — the
 * CRUD action enforces the whitelist with `lintTemplateBody` and runs the
 * full `checkResponseSafety` over the rendered body before any write, so
 * an unsafe template is never storable.
 *
 * `tone` is a text tag, not a pg enum (issue #83 implementation note: the
 * vocabulary will evolve without migrations); the current values live in
 * `TEMPLATE_TONES` in core. `active` is the soft-delete flag — templates
 * are deactivated, never hard-deleted, because published responses may
 * have originated from them.
 */

import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { practices } from "./tenancy.js";

export const responseTemplates = pgTable(
  "response_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    name: text("name").notNull(),
    /** Template text; whitelisted placeholders only (see module doc). */
    body: text("body").notNull(),
    /** Text tone tag (`warm` / `neutral` / `apologetic` today). */
    tone: text("tone").notNull(),
    /** Soft deactivation — hidden from the composer's picker, row kept. */
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The composer's picker and the settings list: practice-scoped scans
    // (the picker filters on active in the same index).
    index("response_templates_practice_id_active_idx").on(
      table.practiceId,
      table.active,
    ),
  ],
);
