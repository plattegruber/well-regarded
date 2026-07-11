/**
 * Clerk webhook sync integration tests (issue #60): the DB upsert paths,
 * against a real Postgres via packages/db's template-clone harness. Every
 * delivery carries a real svix signature (test secret); payloads are the
 * canned fixtures in ./fixtures/clerk with per-test id overrides.
 */

import { resetEnvCache } from "@wellregarded/core";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog } from "../../../packages/db/src/schema/audit.js";
import {
  practices,
  staffMembers,
} from "../../../packages/db/src/schema/tenancy.js";
import { practice as practiceFactory } from "../../../packages/db/test/factories.js";
import { setupTestDb } from "../../../packages/db/test/harness.js";
import {
  requireDatabaseUrl,
  withDatabase,
} from "../../../packages/db/test/support.js";
import organizationCreatedFixture from "./fixtures/clerk/organization.created.json";
import organizationUpdatedFixture from "./fixtures/clerk/organization.updated.json";
import membershipCreatedFixture from "./fixtures/clerk/organizationMembership.created.json";
import membershipDeletedFixture from "./fixtures/clerk/organizationMembership.deleted.json";
import membershipUpdatedFixture from "./fixtures/clerk/organizationMembership.updated.json";
import userUpdatedFixture from "./fixtures/clerk/user.updated.json";
import { testEnv } from "./support/env";
import { deliver } from "./support/webhooks";

const t = setupTestDb();

beforeEach(() => {
  resetEnvCache();
});

function env() {
  return testEnv({
    HYPERDRIVE: {
      connectionString: withDatabase(requireDatabaseUrl(), t.databaseName),
    },
  });
}

type LooseEvent = { type: string; data: Record<string, unknown> };

function orgEvent(
  fixture: unknown,
  overrides: Record<string, unknown> = {},
): LooseEvent {
  const event = structuredClone(fixture) as LooseEvent;
  Object.assign(event.data, overrides);
  return event;
}

function membershipEvent(
  fixture: unknown,
  overrides: {
    organization?: Record<string, unknown>;
    public_user_data?: Record<string, unknown>;
    role?: string;
  } = {},
): LooseEvent {
  const event = structuredClone(fixture) as LooseEvent & {
    data: {
      organization: Record<string, unknown>;
      public_user_data: Record<string, unknown>;
      role: string;
    };
  };
  Object.assign(event.data.organization, overrides.organization ?? {});
  Object.assign(event.data.public_user_data, overrides.public_user_data ?? {});
  if (overrides.role !== undefined) event.data.role = overrides.role;
  return event;
}

async function practiceByOrgId(clerkOrgId: string) {
  return t.db
    .select()
    .from(practices)
    .where(eq(practices.clerkOrgId, clerkOrgId));
}

async function staffByUserId(practiceId: string, clerkUserId: string) {
  return t.db
    .select()
    .from(staffMembers)
    .where(
      and(
        eq(staffMembers.practiceId, practiceId),
        eq(staffMembers.clerkUserId, clerkUserId),
      ),
    );
}

describe("organization.* → practices", () => {
  it("organization.created upserts a practice; duplicate delivery is idempotent", async () => {
    const event = orgEvent(organizationCreatedFixture, {
      id: "org_it_create",
      slug: "it-create-dental",
    });

    const first = await deliver(event, env());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true });

    const replay = await deliver(event, env());
    expect(replay.status).toBe(200);

    const rows = await practiceByOrgId("org_it_create");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Bright Smiles Dental",
      slug: "it-create-dental",
    });
  });

  it("organization.updated refreshes name and slug on the same row", async () => {
    const created = orgEvent(organizationCreatedFixture, {
      id: "org_it_update",
      slug: "it-update-dental",
    });
    await deliver(created, env());
    const [before] = await practiceByOrgId("org_it_update");

    const updated = orgEvent(organizationUpdatedFixture, {
      id: "org_it_update",
      slug: "it-update-dental-group",
    });
    const res = await deliver(updated, env());
    expect(res.status).toBe(200);

    const rows = await practiceByOrgId("org_it_update");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(before?.id);
    expect(rows[0]).toMatchObject({
      name: "Bright Smiles Dental Group",
      slug: "it-update-dental-group",
    });
  });

  it("slug collision with another practice appends a suffix instead of failing", async () => {
    await practiceFactory(t.db, { slug: "contested-slug" });

    const event = orgEvent(organizationCreatedFixture, {
      id: "org_it_slugclash",
      slug: "contested-slug",
    });
    const res = await deliver(event, env());
    expect(res.status).toBe(200);

    const [row] = await practiceByOrgId("org_it_slugclash");
    expect(row?.slug).toMatch(/^contested-slug-[a-z0-9]+$/);

    // Replays converge on the same suffixed slug (deterministic suffix).
    await deliver(event, env());
    const rows = await practiceByOrgId("org_it_slugclash");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe(row?.slug);
  });

  it("audits practice.synced with the webhook system actor", async () => {
    await deliver(
      orgEvent(organizationCreatedFixture, {
        id: "org_it_audit",
        slug: "it-audit-dental",
      }),
      env(),
    );
    const [practiceRow] = await practiceByOrgId("org_it_audit");
    const entries = await t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.practiceId, practiceRow?.id ?? ""),
          eq(auditLog.action, "practice.synced"),
        ),
      );
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]).toMatchObject({
      actorType: "system",
      actorId: "webhook:clerk",
      entityType: "practices",
    });
  });
});

describe("organizationMembership.* → staff_members", () => {
  it("membership for an unseen org creates practice AND staff member (out-of-order tolerance)", async () => {
    const event = membershipEvent(membershipCreatedFixture, {
      organization: { id: "org_it_unseen", slug: "it-unseen-dental" },
      public_user_data: { user_id: "user_it_unseen" },
      role: "org:admin",
    });
    const res = await deliver(event, env());
    expect(res.status).toBe(200);

    const [practiceRow] = await practiceByOrgId("org_it_unseen");
    expect(practiceRow).toBeDefined();
    const staff = await staffByUserId(practiceRow?.id ?? "", "user_it_unseen");
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatchObject({
      email: "dana@brightsmiles.example.com",
      displayName: "Dana Nguyen",
      role: "owner", // ROLE_MAP: org:admin → owner
      deactivatedAt: null,
    });
  });

  it("maps org:member → front_desk and unknown Clerk roles → front_desk", async () => {
    const member = membershipEvent(membershipCreatedFixture, {
      organization: { id: "org_it_roles", slug: "it-roles-dental" },
      public_user_data: { user_id: "user_it_member" },
      role: "org:member",
    });
    await deliver(member, env());

    const custom = membershipEvent(membershipCreatedFixture, {
      organization: { id: "org_it_roles", slug: "it-roles-dental" },
      public_user_data: { user_id: "user_it_custom" },
      role: "org:custom_specialist",
    });
    await deliver(custom, env());

    const [practiceRow] = await practiceByOrgId("org_it_roles");
    const [memberRow] = await staffByUserId(
      practiceRow?.id ?? "",
      "user_it_member",
    );
    const [customRow] = await staffByUserId(
      practiceRow?.id ?? "",
      "user_it_custom",
    );
    expect(memberRow?.role).toBe("front_desk");
    expect(customRow?.role).toBe("front_desk");
  });

  it("never overwrites a role changed in our DB: replayed updates leave role untouched", async () => {
    const created = membershipEvent(membershipCreatedFixture, {
      organization: { id: "org_it_rolekeep", slug: "it-rolekeep-dental" },
      public_user_data: { user_id: "user_it_rolekeep" },
      role: "org:member",
    });
    await deliver(created, env());

    const [practiceRow] = await practiceByOrgId("org_it_rolekeep");
    const practiceId = practiceRow?.id ?? "";
    // Simulate a Settings-side role change (our DB is the role source of
    // truth).
    await t.db
      .update(staffMembers)
      .set({ role: "office_manager" })
      .where(eq(staffMembers.clerkUserId, "user_it_rolekeep"));

    const updated = membershipEvent(membershipUpdatedFixture, {
      organization: { id: "org_it_rolekeep", slug: "it-rolekeep-dental" },
      public_user_data: {
        user_id: "user_it_rolekeep",
        identifier: "rolekeep-new@example.com",
      },
      role: "org:admin",
    });
    const res = await deliver(updated, env());
    expect(res.status).toBe(200);

    const [row] = await staffByUserId(practiceId, "user_it_rolekeep");
    expect(row?.role).toBe("office_manager"); // untouched
    expect(row?.email).toBe("rolekeep-new@example.com"); // profile refreshed
  });

  it("membership.deleted soft-deletes; re-created membership reactivates the SAME row", async () => {
    const created = membershipEvent(membershipCreatedFixture, {
      organization: { id: "org_it_lifecycle", slug: "it-lifecycle-dental" },
      public_user_data: { user_id: "user_it_lifecycle" },
      role: "org:member",
    });
    await deliver(created, env());
    const [practiceRow] = await practiceByOrgId("org_it_lifecycle");
    const practiceId = practiceRow?.id ?? "";
    const [original] = await staffByUserId(practiceId, "user_it_lifecycle");

    const deleted = membershipEvent(membershipDeletedFixture, {
      organization: { id: "org_it_lifecycle", slug: "it-lifecycle-dental" },
      public_user_data: { user_id: "user_it_lifecycle" },
    });
    const deleteRes = await deliver(deleted, env());
    expect(deleteRes.status).toBe(200);

    const [afterDelete] = await staffByUserId(practiceId, "user_it_lifecycle");
    expect(afterDelete?.id).toBe(original?.id);
    expect(afterDelete?.deactivatedAt).not.toBeNull();
    const deactivatedAt = afterDelete?.deactivatedAt;

    // Replayed delete does not churn the timestamp.
    await deliver(deleted, env());
    const [afterReplay] = await staffByUserId(practiceId, "user_it_lifecycle");
    expect(afterReplay?.deactivatedAt?.getTime()).toBe(
      deactivatedAt?.getTime(),
    );

    // Re-adding the member reactivates the same row — FKs to it survive.
    await deliver(created, env());
    const [reactivated] = await staffByUserId(practiceId, "user_it_lifecycle");
    expect(reactivated?.id).toBe(original?.id);
    expect(reactivated?.deactivatedAt).toBeNull();

    // Deactivation was audited.
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.practiceId, practiceId),
          eq(auditLog.action, "staff_member.deactivated"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: "system",
      actorId: "webhook:clerk",
      entityId: original?.id,
    });
  });

  it("membership.deleted for an org we never synced is a 200 no-op", async () => {
    const deleted = membershipEvent(membershipDeletedFixture, {
      organization: { id: "org_it_ghost", slug: "it-ghost-dental" },
      public_user_data: { user_id: "user_it_ghost" },
    });
    const res = await deliver(deleted, env());
    expect(res.status).toBe(200);
    expect(await practiceByOrgId("org_it_ghost")).toHaveLength(0);
  });
});

describe("user.updated → staff_members profile refresh", () => {
  it("refreshes email and display name on the user's rows across two practices", async () => {
    // Same user joins two practices.
    for (const [orgId, slug] of [
      ["org_it_multi_a", "it-multi-a"],
      ["org_it_multi_b", "it-multi-b"],
    ] as const) {
      await deliver(
        membershipEvent(membershipCreatedFixture, {
          organization: { id: orgId, slug },
          public_user_data: { user_id: "user_it_multi" },
          role: "org:member",
        }),
        env(),
      );
    }

    const event = structuredClone(userUpdatedFixture) as LooseEvent;
    Object.assign(event.data, { id: "user_it_multi" });
    const res = await deliver(event, env());
    expect(res.status).toBe(200);

    const rows = await t.db
      .select()
      .from(staffMembers)
      .where(eq(staffMembers.clerkUserId, "user_it_multi"));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // Primary email wins (fixture carries a secondary too).
      expect(row.email).toBe("dana.new@brightsmiles.example.com");
      expect(row.displayName).toBe("Dana Nguyen-Lee");
    }
  });

  it("is a no-op for users with no staff rows", async () => {
    const event = structuredClone(userUpdatedFixture) as LooseEvent;
    Object.assign(event.data, { id: "user_it_nobody" });
    const res = await deliver(event, env());
    expect(res.status).toBe(200);
  });
});
