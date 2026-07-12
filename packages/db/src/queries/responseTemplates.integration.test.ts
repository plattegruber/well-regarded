/**
 * Integration tests for `response_templates` (issue #83, migration 0021)
 * on the #49 harness: practice-scoped CRUD round-trip with same-transaction
 * audit rows, soft deactivation (hidden from the picker view, row kept),
 * and starter-template seeding idempotency.
 *
 *   docker compose up -d && pnpm --filter @wellregarded/db test:integration
 */

import type { Actor } from "@wellregarded/core";
import { STARTER_RESPONSE_TEMPLATES } from "@wellregarded/core";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  practice,
  responseTemplate,
  staffMember,
} from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import { auditLog } from "../schema/audit.js";
import {
  createResponseTemplate,
  getResponseTemplate,
  listResponseTemplates,
  seedStarterTemplates,
  updateResponseTemplate,
} from "./responseTemplates.js";

describe("response templates (integration)", () => {
  const t = setupTestDb();
  let practiceId: string;
  let actor: Actor;

  beforeAll(async () => {
    const staff = await staffMember(t.db, { role: "owner" });
    practiceId = staff.practiceId;
    actor = { type: "staff", id: staff.id };
  });

  async function auditRows(entityId: string) {
    return t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "response_templates"),
          eq(auditLog.entityId, entityId),
        ),
      );
  }

  it("creates, reads, and updates a template with audit rows in step", async () => {
    const created = await createResponseTemplate(t.db, {
      practiceId,
      name: "Weekend thanks",
      body: "Thank you for the kind words — the {practice_name} team.",
      tone: "warm",
      actor,
    });
    expect(created.active).toBe(true);

    const fetched = await getResponseTemplate(t.db, practiceId, created.id);
    expect(fetched?.name).toBe("Weekend thanks");

    const updated = await updateResponseTemplate(t.db, {
      practiceId,
      templateId: created.id,
      patch: { body: "Thank you — the {practice_name} team.", tone: "neutral" },
      actor,
    });
    expect(updated?.tone).toBe("neutral");
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      created.updatedAt.getTime(),
    );

    const audits = await auditRows(created.id);
    expect(audits.map((row) => row.action).sort()).toEqual([
      "response_template.created",
      "response_template.updated",
    ]);
  });

  it("scopes reads by practice — a foreign id reads as missing", async () => {
    const mine = await responseTemplate(t.db, { practiceId });
    const other = await practice(t.db);
    expect(await getResponseTemplate(t.db, other.id, mine.id)).toBeUndefined();
    expect(
      await updateResponseTemplate(t.db, {
        practiceId: other.id,
        templateId: mine.id,
        patch: { name: "Hijacked" },
        actor,
      }),
    ).toBeUndefined();
    const otherList = await listResponseTemplates(t.db, other.id);
    expect(otherList.find((row) => row.id === mine.id)).toBeUndefined();
  });

  it("deactivation is soft: hidden from the picker view, row kept, audited", async () => {
    const template = await responseTemplate(t.db, { practiceId });

    const deactivated = await updateResponseTemplate(t.db, {
      practiceId,
      templateId: template.id,
      patch: { active: false },
      actor,
    });
    expect(deactivated?.active).toBe(false);

    const pickerView = await listResponseTemplates(t.db, practiceId, {
      activeOnly: true,
    });
    expect(pickerView.find((row) => row.id === template.id)).toBeUndefined();

    const settingsView = await listResponseTemplates(t.db, practiceId);
    expect(settingsView.find((row) => row.id === template.id)?.active).toBe(
      false,
    );

    const audits = await auditRows(template.id);
    expect(audits.map((row) => row.action)).toContain(
      "response_template.deactivated",
    );

    // Reactivation flips it back and audits distinctly.
    const reactivated = await updateResponseTemplate(t.db, {
      practiceId,
      templateId: template.id,
      patch: { active: true },
      actor,
    });
    expect(reactivated?.active).toBe(true);
    expect((await auditRows(template.id)).map((row) => row.action)).toContain(
      "response_template.activated",
    );
  });

  it("seeds the four starters only into an empty practice — idempotent", async () => {
    const fresh = await practice(t.db);

    const first = await seedStarterTemplates(t.db, {
      practiceId: fresh.id,
      actor,
    });
    expect(first).toBe(STARTER_RESPONSE_TEMPLATES.length);

    const second = await seedStarterTemplates(t.db, {
      practiceId: fresh.id,
      actor,
    });
    expect(second).toBe(0);

    const rows = await listResponseTemplates(t.db, fresh.id);
    expect(rows).toHaveLength(STARTER_RESPONSE_TEMPLATES.length);
    expect(rows.map((row) => row.name).sort()).toEqual(
      STARTER_RESPONSE_TEMPLATES.map((tpl) => tpl.name).sort(),
    );
  });

  it("never resurrects starters a practice deactivated (count > 0 short-circuits)", async () => {
    const fresh = await practice(t.db);
    await seedStarterTemplates(t.db, { practiceId: fresh.id, actor });
    const rows = await listResponseTemplates(t.db, fresh.id);
    for (const row of rows) {
      await updateResponseTemplate(t.db, {
        practiceId: fresh.id,
        templateId: row.id,
        patch: { active: false },
        actor,
      });
    }
    expect(
      await seedStarterTemplates(t.db, { practiceId: fresh.id, actor }),
    ).toBe(0);
    expect(
      await listResponseTemplates(t.db, fresh.id, { activeOnly: true }),
    ).toHaveLength(0);
  });
});
