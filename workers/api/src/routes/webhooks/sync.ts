/**
 * Clerk → DB sync mutations (issue #60, Epic #4).
 *
 * Clerk is the source of truth for who exists and which organization they
 * belong to; our DB is the source of truth for everything else (roles,
 * location scoping, every FK). Each function here is an idempotent upsert
 * keyed on the natural unique key — duplicate and re-delivered events
 * converge to the same state, no processed-event ledger needed.
 *
 * Every mutation runs its `audit()` call in the same transaction as the
 * change it records (Epic #3 convention), with the system actor
 * `{ type: "system", id: "webhook:clerk" }`.
 */

import {
  DEFAULT_SYNCED_ROLE,
  ROLE_MAP,
  type StaffRole,
} from "@wellregarded/core";
import { audit, type Db, schema, type Tx } from "@wellregarded/db";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";

import type { OrganizationData, PublicUserData } from "./payloads";

const { practices, staffMembers } = schema;

const WEBHOOK_ACTOR = { type: "system", id: "webhook:clerk" } as const;

/**
 * Role applied on INSERT only — updates never touch `role`, so a role
 * changed in our DB (Settings, later) survives webhook replays. It only
 * drifts from Clerk when the membership row is (re)created.
 */
export function mapClerkRole(clerkRole: string): StaffRole {
  const mapped = ROLE_MAP[clerkRole];
  if (mapped) return mapped;
  console.warn(
    `clerk webhook: unknown Clerk role ${JSON.stringify(clerkRole)} — ` +
      `defaulting to ${DEFAULT_SYNCED_ROLE}`,
  );
  return DEFAULT_SYNCED_ROLE;
}

function displayNameFrom(user: {
  first_name?: string | null | undefined;
  last_name?: string | null | undefined;
}): string | null {
  const name = [user.first_name, user.last_name]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .trim();
  return name.length > 0 ? name : null;
}

/**
 * `practices.slug` is globally unique while Clerk slugs are only unique
 * per Clerk instance-of-truth; if another practice already owns the slug,
 * append a short deterministic suffix (derived from the org id, so
 * replays converge on the same value) instead of failing the webhook.
 */
async function resolveSlug(
  db: Db | Tx,
  org: OrganizationData,
): Promise<string> {
  // Pre-check instead of insert-and-retry: a failed INSERT would abort the
  // surrounding transaction. The check-then-insert race is acceptable —
  // if two webhooks race, one fails, svix retries it, and the retry sees
  // the winner's row and suffixes.
  const [taken] = await db
    .select({ id: practices.id })
    .from(practices)
    .where(and(eq(practices.slug, org.slug), ne(practices.clerkOrgId, org.id)))
    .limit(1);
  if (!taken) return org.slug;
  const suffix = org.id
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-6)
    .toLowerCase();
  return `${org.slug}-${suffix}`;
}

/**
 * Upsert a practice from a Clerk organization object (either a top-level
 * organization.* event or the `organization` nested in a membership event
 * — out-of-order delivery tolerance). Returns the practice id.
 */
export async function syncPractice(
  tx: Db | Tx,
  org: OrganizationData,
): Promise<string> {
  const slug = await resolveSlug(tx, org);
  const [row] = await tx
    .insert(practices)
    .values({ clerkOrgId: org.id, name: org.name, slug })
    .onConflictDoUpdate({
      target: practices.clerkOrgId,
      set: { name: org.name, slug, updatedAt: new Date() },
    })
    .returning({ id: practices.id });
  if (!row) throw new Error("practice upsert returned no row");
  await audit(tx, {
    practiceId: row.id,
    actor: WEBHOOK_ACTOR,
    action: "practice.synced",
    entityType: "practices",
    entityId: row.id,
    payload: { clerkOrgId: org.id },
  });
  return row.id;
}

/**
 * Upsert a staff member from a membership event. Re-adding a removed
 * member reactivates the same row (clears `deactivated_at`), preserving
 * every FK that points at it. `role` is set on insert only — see
 * `mapClerkRole`.
 */
export async function syncMembership(
  db: Db,
  membership: {
    organization: OrganizationData;
    public_user_data: PublicUserData;
    role: string;
  },
): Promise<void> {
  const user = membership.public_user_data;
  const displayName = displayNameFrom(user);
  await db.transaction(async (tx) => {
    // Out-of-order tolerance: membership events for an org we have not
    // seen yet upsert the practice from the nested organization first.
    const practiceId = await syncPractice(tx, membership.organization);
    const [row] = await tx
      .insert(staffMembers)
      .values({
        practiceId,
        clerkUserId: user.user_id,
        email: user.identifier,
        displayName,
        role: mapClerkRole(membership.role),
      })
      .onConflictDoUpdate({
        target: [staffMembers.practiceId, staffMembers.clerkUserId],
        // No `role` here, deliberately (issue #60 requirement 4).
        set: {
          email: user.identifier,
          displayName,
          deactivatedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning({ id: staffMembers.id });
    if (!row) throw new Error("staff member upsert returned no row");
    await audit(tx, {
      practiceId,
      actor: WEBHOOK_ACTOR,
      action: "staff_member.synced",
      entityType: "staff_members",
      entityId: row.id,
      payload: { clerkUserId: user.user_id },
    });
  });
}

/**
 * Soft-delete on membership removal: set `deactivated_at`, never
 * hard-delete (audit_log and future assignments reference staff rows).
 * A no-op when the org/member was never synced or is already deactivated
 * (replay tolerance — the timestamp does not churn).
 */
export async function deactivateMembership(
  db: Db,
  membership: {
    organization: OrganizationData;
    public_user_data: PublicUserData;
  },
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(staffMembers)
      .set({ deactivatedAt: now, updatedAt: now })
      .where(
        and(
          inArray(
            staffMembers.practiceId,
            tx
              .select({ id: practices.id })
              .from(practices)
              .where(eq(practices.clerkOrgId, membership.organization.id)),
          ),
          eq(staffMembers.clerkUserId, membership.public_user_data.user_id),
          isNull(staffMembers.deactivatedAt),
        ),
      )
      .returning({ id: staffMembers.id, practiceId: staffMembers.practiceId });
    for (const row of rows) {
      await audit(tx, {
        practiceId: row.practiceId,
        actor: WEBHOOK_ACTOR,
        action: "staff_member.deactivated",
        entityType: "staff_members",
        entityId: row.id,
      });
    }
  });
}

/**
 * Refresh profile fields on every staff row of a user (a user in two
 * practices has two rows). Email prefers the primary address; when the
 * payload carries no email at all, the stored email is kept.
 */
export async function syncUserProfile(
  db: Db,
  user: {
    id: string;
    email_addresses: Array<{ id: string; email_address: string }>;
    primary_email_address_id?: string | null | undefined;
    first_name?: string | null | undefined;
    last_name?: string | null | undefined;
  },
): Promise<void> {
  const primary =
    user.email_addresses.find(
      (address) => address.id === user.primary_email_address_id,
    ) ?? user.email_addresses[0];
  const displayName = displayNameFrom(user);
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(staffMembers)
      .set({
        ...(primary ? { email: primary.email_address } : {}),
        displayName,
        updatedAt: new Date(),
      })
      .where(eq(staffMembers.clerkUserId, user.id))
      .returning({ id: staffMembers.id, practiceId: staffMembers.practiceId });
    for (const row of rows) {
      await audit(tx, {
        practiceId: row.practiceId,
        actor: WEBHOOK_ACTOR,
        action: "staff_member.synced",
        entityType: "staff_members",
        entityId: row.id,
        payload: { clerkUserId: user.id },
      });
    }
  });
}
