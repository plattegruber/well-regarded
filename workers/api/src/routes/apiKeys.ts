/**
 * API key management endpoints (issue #81, Epic #4), mounted under the
 * staff-auth group at /api/api-keys — staff JWTs manage keys; the keys
 * themselves authenticate the separate proof group. Every route is gated
 * by `requirePermission("manage_api_keys")` (matrix: owner only), and
 * create/revoke are audited via `audit()` in the same transaction as the
 * mutation.
 *
 * Show-once contract: POST's response is the ONLY place the plaintext key
 * ever appears. The list endpoint returns `prefix` + `last4` display
 * hints and never a hash — a hash is not secret-like today, but returning
 * it invites clients to depend on it. The Settings UI for these endpoints
 * ships with Epic #14.
 */

import {
  API_KEY_ENVIRONMENTS,
  generateApiKey,
  type StaffActor,
} from "@wellregarded/core";
import { audit, schema } from "@wellregarded/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { AppEnv } from "../bindings";
import { requirePermission } from "../middleware/staffAuth";

const { apiKeys } = schema;

const createBodySchema = z.object({
  name: z.string().trim().min(1),
  environment: z.enum(API_KEY_ENVIRONMENTS),
});

/** `pk_live_` / `pk_test_` — the display prefix for the key list UI. */
function keyPrefix(environment: "live" | "test"): string {
  return `pk_${environment}_`;
}

function staffAuditActor(actor: StaffActor): { type: "staff"; id: string } {
  return { type: "staff", id: actor.staffId };
}

export const apiKeyRoutes = new Hono<AppEnv>();

apiKeyRoutes.use("*", requirePermission("manage_api_keys"));

/**
 * List the actor's practice's keys, newest first. Display fields only —
 * never `key_hash`, never a plaintext key.
 */
apiKeyRoutes.get("/", async (c) => {
  const actor = c.get("actor");
  const rows = await c
    .get("db")
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      environment: apiKeys.environment,
      last4: apiKeys.last4,
      createdAt: apiKeys.createdAt,
      revokedAt: apiKeys.revokedAt,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.practiceId, actor.practiceId))
    .orderBy(desc(apiKeys.createdAt));
  return c.json({
    apiKeys: rows.map((row) => ({
      ...row,
      prefix: keyPrefix(row.environment),
    })),
  });
});

/**
 * Create a key. The response's `key` field is the plaintext, returned
 * exactly once — the row stores only its hash and `last4`.
 */
apiKeyRoutes.post("/", async (c) => {
  const body = createBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request" as const }, 400);
  const { name, environment } = body.data;

  const actor = c.get("actor");
  const generated = await generateApiKey(environment);

  const row = await c.get("db").transaction(async (tx) => {
    const [inserted] = await tx
      .insert(apiKeys)
      .values({
        practiceId: actor.practiceId,
        name,
        environment,
        keyHash: generated.hash,
        last4: generated.last4,
        createdBy: actor.staffId,
      })
      .returning();
    if (!inserted) throw new Error("api key insert returned no row");
    await audit(tx, {
      practiceId: actor.practiceId,
      actor: staffAuditActor(actor),
      action: "api_key.created",
      entityType: "api_keys",
      entityId: inserted.id,
      payload: { name, environment, last4: generated.last4 },
    });
    return inserted;
  });

  return c.json(
    {
      id: row.id,
      name: row.name,
      environment: row.environment,
      /** Shown once. Not stored, not logged, not retrievable again. */
      key: generated.key,
      prefix: keyPrefix(row.environment),
      last4: row.last4,
      createdAt: row.createdAt,
    },
    201,
  );
});

/**
 * Revoke a key: stamps `revoked_at`; the next `resolveApiKey` lookup
 * misses immediately (no cache — when Epic #14 adds KV caching of key
 * lookups, that issue owns invalidation). Idempotent: revoking an
 * already-revoked key returns its existing `revoked_at` without a second
 * audit row. Keys are never deleted — the row is audit history. Unknown
 * ids and other practices' ids are the same 404.
 */
apiKeyRoutes.post("/:id/revoke", async (c) => {
  const id = z.uuid().safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" as const }, 404);

  const actor = c.get("actor");
  const db = c.get("db");

  const revoked = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeys.id, id.data),
          eq(apiKeys.practiceId, actor.practiceId),
          isNull(apiKeys.revokedAt),
        ),
      )
      .returning();
    if (!updated) return null;
    await audit(tx, {
      practiceId: actor.practiceId,
      actor: staffAuditActor(actor),
      action: "api_key.revoked",
      entityType: "api_keys",
      entityId: updated.id,
      payload: {
        name: updated.name,
        environment: updated.environment,
        last4: updated.last4,
      },
    });
    return updated;
  });
  if (revoked) {
    return c.json({ id: revoked.id, revokedAt: revoked.revokedAt });
  }

  // Nothing transitioned: either already revoked (idempotent success,
  // return the original timestamp) or not this practice's key (404).
  const [existing] = await db
    .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(
      and(eq(apiKeys.id, id.data), eq(apiKeys.practiceId, actor.practiceId)),
    )
    .limit(1);
  if (!existing) return c.json({ error: "not_found" as const }, 404);
  return c.json({ id: existing.id, revokedAt: existing.revokedAt });
});
