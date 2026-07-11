import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  location,
  practice,
  provider,
  staffMember,
} from "../../test/factories.js";
import { pgError, setupTestDb } from "../../test/harness.js";
import { practices, providers, staffMembers } from "./tenancy.js";

/**
 * Integration tests for the tenancy tables (migration 0002) against a real
 * Postgres, on the #49 harness (own database per file, factories for
 * fixtures, no cleanup needed). Run locally with:
 *
 *   docker compose up -d && pnpm --filter @wellregarded/db test:integration
 */

/** Postgres error codes asserted below. */
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

describe("tenancy tables (integration)", () => {
  const t = setupTestDb();

  it("inserts a practice, location, provider, and staff member and reads them back", async () => {
    const p = await practice(t.db);
    expect(p.timezone).toBe("America/Chicago");
    expect(p.createdAt).toBeInstanceOf(Date);
    expect(p.updatedAt).toBeInstanceOf(Date);

    const loc = await location(t.db, { practiceId: p.id, name: "Downtown" });

    const staff = await staffMember(t.db, {
      practiceId: p.id,
      role: "provider",
      locationId: loc.id,
    });
    expect(staff.deactivatedAt).toBeNull();

    const doc = await provider(t.db, {
      practiceId: p.id,
      locationId: loc.id,
      displayName: "Dr. Shah",
      credentials: "DDS",
      staffMemberId: staff.id,
    });
    expect(doc.active).toBe(true);

    const fetched = await t.db
      .select()
      .from(providers)
      .where(eq(providers.id, doc.id));
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.displayName).toBe("Dr. Shah");
    expect(fetched[0]?.staffMemberId).toBe(staff.id);

    const fetchedStaff = await t.db
      .select()
      .from(staffMembers)
      .where(eq(staffMembers.practiceId, p.id));
    expect(fetchedStaff).toHaveLength(1);
    expect(fetchedStaff[0]?.role).toBe("provider");
  });

  it("rejects a duplicate clerk_org_id", async () => {
    const p = await practice(t.db);
    const { code } = await pgError(
      t.db.insert(practices).values({
        clerkOrgId: p.clerkOrgId,
        name: "Copycat Practice",
        slug: "copycat",
      }),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it("rejects a duplicate (practice_id, clerk_user_id) staff member, but allows the same user in a second practice", async () => {
    const practiceA = await practice(t.db);
    const practiceB = await practice(t.db);
    const clerkUserId = "user_twopractices";

    await staffMember(t.db, { practiceId: practiceA.id, clerkUserId });

    const { code } = await pgError(
      t.db.insert(staffMembers).values({
        practiceId: practiceA.id,
        clerkUserId,
        email: "two-again@example.com",
      }),
    );
    expect(code).toBe(UNIQUE_VIOLATION);

    // One membership row per user per practice — a user in two practices
    // gets two rows.
    const second = await staffMember(t.db, {
      practiceId: practiceB.id,
      clerkUserId,
    });
    expect(second.practiceId).toBe(practiceB.id);
  });

  it("rejects a staff member with a nonexistent practice_id", async () => {
    const { code } = await pgError(
      t.db.insert(staffMembers).values({
        practiceId: randomUUID(),
        clerkUserId: "user_orphan",
        email: "orphan@example.com",
      }),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });
});
