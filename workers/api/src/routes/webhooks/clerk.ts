/**
 * POST /webhooks/clerk (issue #60, Epic #4).
 *
 * Mounted OUTSIDE the staff-auth middleware — its only auth is the svix
 * signature, verified against the RAW request body before any JSON is
 * parsed. Missing/invalid signature → 400 with no body detail.
 *
 * Any event type we do not handle is acked with `200 {"received": true}`:
 * Clerk retries non-2xx deliveries, and we must never error on events we
 * don't care about. Handlers are idempotent upserts (see ./sync.ts), so
 * duplicate/re-delivered/out-of-order events converge — replay away.
 *
 * The handler completes inline (two DB statements through Hyperdrive),
 * comfortably under svix's timeout — no queue.
 */

import { apiEnvSchema, getEnv } from "@wellregarded/core";
import { type Context, Hono } from "hono";
import { Webhook } from "svix";

import type { AppEnv } from "../../bindings";
import {
  clerkEventSchema,
  membershipDataSchema,
  organizationDataSchema,
  userDataSchema,
} from "./payloads";
import {
  deactivateMembership,
  syncMembership,
  syncPractice,
  syncUserProfile,
} from "./sync";

export const clerkWebhook = new Hono<AppEnv>();

clerkWebhook.post("/clerk", async (c) => {
  const env = getEnv(c.env, apiEnvSchema);
  const secret = env.CLERK_WEBHOOK_SIGNING_SECRET;
  if (!secret) {
    // Misconfiguration → 500 via app.onError; svix will retry once the
    // secret is set. See docs/secrets.md § "Flipping on real Clerk keys".
    throw new Error(
      "CLERK_WEBHOOK_SIGNING_SECRET is not configured — cannot verify " +
        "Clerk webhooks. See docs/secrets.md.",
    );
  }

  // Raw body first; JSON parsing only happens after verification.
  const rawBody = await c.req.text();
  let verified: unknown;
  try {
    verified = new Webhook(secret).verify(rawBody, {
      "svix-id": c.req.header("svix-id") ?? "",
      "svix-timestamp": c.req.header("svix-timestamp") ?? "",
      "svix-signature": c.req.header("svix-signature") ?? "",
    });
  } catch {
    return c.body(null, 400);
  }

  const envelope = clerkEventSchema.safeParse(verified);
  if (!envelope.success) return c.body(null, 400);
  const { type, data } = envelope.data;

  const received = () => c.json({ received: true });

  switch (type) {
    case "organization.created":
    case "organization.updated": {
      const org = organizationDataSchema.safeParse(data);
      if (!org.success) return malformed(c, type);
      const db = c.get("db");
      await db.transaction(async (tx) => {
        await syncPractice(tx, org.data);
      });
      return received();
    }

    case "organizationMembership.created":
    case "organizationMembership.updated": {
      const membership = membershipDataSchema.safeParse(data);
      if (!membership.success) return malformed(c, type);
      await syncMembership(c.get("db"), membership.data);
      return received();
    }

    case "organizationMembership.deleted": {
      const membership = membershipDataSchema.safeParse(data);
      if (!membership.success) return malformed(c, type);
      await deactivateMembership(c.get("db"), membership.data);
      return received();
    }

    case "user.updated": {
      const user = userDataSchema.safeParse(data);
      if (!user.success) return malformed(c, type);
      await syncUserProfile(c.get("db"), user.data);
      return received();
    }

    default:
      // Unknown event type: ack and log — never a retry loop.
      console.log(`clerk webhook: ignoring event type ${JSON.stringify(type)}`);
      return received();
  }
});

/**
 * A handled event type whose payload doesn't match the shape we rely on is
 * a contract bug worth surfacing: 400 makes the delivery visible as failed
 * in the Clerk/svix dashboard instead of silently dropping the sync.
 */
function malformed(c: Context<AppEnv>, type: string) {
  console.error(`clerk webhook: malformed ${type} payload`);
  return c.body(null, 400);
}
