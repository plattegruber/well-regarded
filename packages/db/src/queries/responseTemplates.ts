/**
 * `response_templates` queries (issue #83, Epic #10).
 *
 * Writes are audited in the same transaction (`response_template.created`
 * / `.updated` / `.deactivated` / `.activated` / `.seeded`) — templates
 * are `manage_settings` territory, and settings changes leave a trail.
 *
 * SAFETY IS THE CALLER'S GATE, DELIBERATELY: these helpers persist rows;
 * the dashboard action runs `lintTemplateBody` + `checkResponseSafety`
 * BEFORE calling them (the AI provider lives at the app edge, and
 * packages/db must not depend on packages/ai). Any new write path for
 * templates must run the same gate.
 */

import type { Actor } from "@wellregarded/core";
import { STARTER_RESPONSE_TEMPLATES } from "@wellregarded/core";
import { and, asc, count, eq } from "drizzle-orm";

import { audit, type Tx } from "../audit.js";
import type { Db } from "../client.js";
import { responseTemplates } from "../schema/responseTemplates.js";

export type ResponseTemplate = typeof responseTemplates.$inferSelect;

/** One template by id, practice-scoped. */
export async function getResponseTemplate(
  db: Db | Tx,
  practiceId: string,
  templateId: string,
): Promise<ResponseTemplate | undefined> {
  const [row] = await db
    .select()
    .from(responseTemplates)
    .where(
      and(
        eq(responseTemplates.id, templateId),
        eq(responseTemplates.practiceId, practiceId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * A practice's templates, name-ordered. `activeOnly` is the composer's
 * picker view; the settings list shows everything (deactivated rows render
 * greyed, never vanish).
 */
export async function listResponseTemplates(
  db: Db | Tx,
  practiceId: string,
  options: { activeOnly?: boolean } = {},
): Promise<ResponseTemplate[]> {
  const conditions = options.activeOnly
    ? and(
        eq(responseTemplates.practiceId, practiceId),
        eq(responseTemplates.active, true),
      )
    : eq(responseTemplates.practiceId, practiceId);
  return db
    .select()
    .from(responseTemplates)
    .where(conditions)
    .orderBy(asc(responseTemplates.name), asc(responseTemplates.id));
}

export interface CreateResponseTemplateInput {
  practiceId: string;
  name: string;
  body: string;
  tone: string;
  /** Audit actor (the settings-managing staff member). */
  actor: Actor;
}

/** Create a template, audited in the same transaction. */
export async function createResponseTemplate(
  db: Db,
  input: CreateResponseTemplateInput,
): Promise<ResponseTemplate> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(responseTemplates)
      .values({
        practiceId: input.practiceId,
        name: input.name,
        body: input.body,
        tone: input.tone,
      })
      .returning();
    if (!row) throw new Error("response_template insert returned no row");
    await audit(tx, {
      practiceId: input.practiceId,
      actor: input.actor,
      action: "response_template.created",
      entityType: "response_templates",
      entityId: row.id,
      payload: { name: input.name, tone: input.tone },
    });
    return row;
  });
}

export interface UpdateResponseTemplateInput {
  practiceId: string;
  templateId: string;
  patch: Partial<Pick<ResponseTemplate, "name" | "body" | "tone" | "active">>;
  actor: Actor;
}

/**
 * Update a template (content edits and the soft active flip), audited.
 * Returns `undefined` when the id does not exist in this practice.
 */
export async function updateResponseTemplate(
  db: Db,
  input: UpdateResponseTemplateInput,
): Promise<ResponseTemplate | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(responseTemplates)
      .set({ ...input.patch, updatedAt: new Date() })
      .where(
        and(
          eq(responseTemplates.id, input.templateId),
          eq(responseTemplates.practiceId, input.practiceId),
        ),
      )
      .returning();
    if (!row) return undefined;
    const action =
      input.patch.active === false
        ? "response_template.deactivated"
        : input.patch.active === true && Object.keys(input.patch).length === 1
          ? "response_template.activated"
          : "response_template.updated";
    await audit(tx, {
      practiceId: input.practiceId,
      actor: input.actor,
      action,
      entityType: "response_templates",
      entityId: row.id,
      payload: { fields: Object.keys(input.patch) },
    });
    return row;
  });
}

/**
 * Seed the four starter templates (issue #83 requirement 5) — idempotent:
 * inserts only when the practice has ZERO templates, so re-running never
 * duplicates and never resurrects a template the practice deactivated.
 * Copy lives in `STARTER_RESPONSE_TEMPLATES` in `@wellregarded/core`
 * (deterministically safe; asserted against the deterministic safety layer
 * in packages/ai's tests). Callers may pass explicit ids (the demo seed's
 * deterministic ids); rows are audited as `response_template.seeded`.
 */
export async function seedStarterTemplates(
  db: Db | Tx,
  input: {
    practiceId: string;
    actor: Actor;
    /** Optional deterministic id per starter key (the demo seed). */
    ids?: Partial<Record<string, string>>;
  },
): Promise<number> {
  const [existing] = await db
    .select({ value: count() })
    .from(responseTemplates)
    .where(eq(responseTemplates.practiceId, input.practiceId));
  if ((existing?.value ?? 0) > 0) return 0;

  const rows = await db
    .insert(responseTemplates)
    .values(
      STARTER_RESPONSE_TEMPLATES.map((template) => ({
        ...(input.ids?.[template.key] ? { id: input.ids[template.key] } : {}),
        practiceId: input.practiceId,
        name: template.name,
        body: template.body,
        tone: template.tone,
      })),
    )
    .returning({ id: responseTemplates.id });
  for (const row of rows) {
    await audit(db, {
      practiceId: input.practiceId,
      actor: input.actor,
      action: "response_template.seeded",
      entityType: "response_templates",
      entityId: row.id,
    });
  }
  return rows.length;
}
