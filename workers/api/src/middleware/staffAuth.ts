/**
 * Staff authentication middleware (issue #68, Epic #4).
 *
 * Answers exactly one question — "who is asking, in which practice?" — and
 * publishes the answer as a typed `StaffActor` on context. Route handlers
 * never touch raw JWTs and can never forget practice scoping; permission
 * checks happen per-route via `requirePermission` / `can()` against
 * `c.get("actor")`, enforced server-side here, never only in UI.
 *
 * Token verification is networkless: `verifyToken` from @clerk/backend
 * with `jwtKey` (the CLERK_JWKS_PUBLIC_KEY PEM) verifies the RS256
 * signature locally — no Clerk API round-trip per request. Actor
 * resolution is one indexed DB round-trip per request, never cached in
 * module scope (isolates make that unreliable, and staleness on role
 * changes would be a security bug).
 *
 * Status semantics (issue #68 requirement 5):
 * - 401 `{ error: "unauthenticated" }` — no/malformed/expired token or bad
 *   signature: "who are you?"
 * - 403 `{ error: "forbidden", reason }` — valid token, but no active org
 *   (`no_org`); the org or membership is not in our DB yet — webhook sync
 *   lag, retry shortly (`unknown_org`); the staff row is deactivated
 *   (`deactivated`); or a `requirePermission` failure (`permission`).
 * Error bodies never leak which practice or user exists.
 *
 * The dashboard (Epic #5) calls these APIs during SSR from another Worker:
 * cookie-based auth plus `authorizedParties` covers that today. If those
 * calls ever move to a service binding, authentication for them would move
 * to the binding itself — a future concern, noted here on purpose.
 */

import { verifyToken } from "@clerk/backend";
import {
  type Action,
  apiEnvSchema,
  can,
  getEnv,
  type StaffActor,
} from "@wellregarded/core";
import { schema } from "@wellregarded/db";
import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

import type { AppEnv } from "../bindings";
import { extractOrgClaims } from "./sessionClaims";

const { practices, staffMembers } = schema;

export type ForbiddenReason =
  | "no_org"
  | "unknown_org"
  | "deactivated"
  | "permission";

function unauthenticated(c: Context<AppEnv>) {
  return c.json({ error: "unauthenticated" as const }, 401);
}

function forbidden(c: Context<AppEnv>, reason: ForbiddenReason) {
  return c.json({ error: "forbidden" as const, reason }, 403);
}

/**
 * `Authorization: Bearer <jwt>` first (API clients), falling back to the
 * `__session` cookie (same-origin dashboard SSR calls send the cookie).
 */
function tokenFromRequest(c: Context<AppEnv>): string | null {
  const authorization = c.req.header("Authorization");
  if (authorization) {
    const [scheme, token] = authorization.split(" ");
    if (scheme?.toLowerCase() === "bearer" && token) return token;
    return null; // A malformed Authorization header never falls back.
  }
  return getCookie(c, "__session") ?? null;
}

/**
 * Requires `withDb()` upstream (it reads `c.get("db")`). On success sets
 * `actor` for every downstream handler.
 */
export function staffAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const env = getEnv(c.env, apiEnvSchema);
    const jwtKey = env.CLERK_JWKS_PUBLIC_KEY;
    if (!jwtKey) {
      // Misconfiguration, not an auth outcome: surfaces as a 500 via the
      // app's onError. See docs/secrets.md § "Flipping on real Clerk keys".
      throw new Error(
        "CLERK_JWKS_PUBLIC_KEY is not configured — staff routes cannot " +
          "verify session tokens. See docs/secrets.md.",
      );
    }

    const token = tokenFromRequest(c);
    if (!token) return unauthenticated(c);

    let payload: Awaited<ReturnType<typeof verifyToken>>;
    try {
      payload = await verifyToken(token, {
        jwtKey,
        ...(env.CLERK_AUTHORIZED_PARTIES
          ? {
              authorizedParties: env.CLERK_AUTHORIZED_PARTIES.split(",")
                .map((party) => party.trim())
                .filter(Boolean),
            }
          : {}),
      });
    } catch {
      // Bad signature, expired, malformed, wrong azp, … — all "who are
      // you?". Details are deliberately not echoed to the client.
      return unauthenticated(c);
    }

    const { orgId } = extractOrgClaims(payload);
    if (!orgId) return forbidden(c, "no_org");

    // One round-trip: practice by clerk_org_id joined to the caller's
    // staff row. Both lookups are indexed (practices.clerk_org_id unique,
    // staff_members (practice_id, clerk_user_id) unique).
    const db = c.get("db");
    const [row] = await db
      .select({
        practiceId: practices.id,
        staffId: staffMembers.id,
        role: staffMembers.role,
        locationId: staffMembers.locationId,
        deactivatedAt: staffMembers.deactivatedAt,
      })
      .from(practices)
      .leftJoin(
        staffMembers,
        and(
          eq(staffMembers.practiceId, practices.id),
          eq(staffMembers.clerkUserId, payload.sub),
        ),
      )
      .where(eq(practices.clerkOrgId, orgId))
      .limit(1);

    // Unknown practice AND unknown membership share one reason: both are
    // webhook sync lag from the caller's perspective (retry shortly), and
    // distinct reasons would leak whether the org exists in our DB.
    if (!row || row.staffId === null || row.role === null) {
      return forbidden(c, "unknown_org");
    }
    if (row.deactivatedAt !== null) return forbidden(c, "deactivated");

    const actor: StaffActor = {
      type: "staff",
      staffId: row.staffId,
      practiceId: row.practiceId,
      role: row.role,
      locationId: row.locationId,
    };
    c.set("actor", actor);
    await next();
  };
}

/**
 * Practice-level permission gate (issue #68 requirement 4): 403
 * `{ error: "forbidden", reason: "permission" }` when the actor's role
 * denies `action`. Routes that need resource-level location checks call
 * `can()` themselves with the real resource.
 */
export function requirePermission(action: Action): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = c.get("actor");
    if (!actor || !can(actor, action, { practiceId: actor.practiceId })) {
      return forbidden(c, "permission");
    }
    await next();
  };
}
