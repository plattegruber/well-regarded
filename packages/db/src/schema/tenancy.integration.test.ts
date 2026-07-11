import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type Db, type Sql } from "../client.js";
import { locations, practices, providers, staffMembers } from "./tenancy.js";

/**
 * Integration tests for the tenancy tables (migration 0002) against a real
 * Postgres — the local compose database.
 *
 * Run with:
 *
 *   docker compose up -d && pnpm db:migrate && \
 *     DATABASE_URL=postgres://... pnpm --filter @wellregarded/db test
 *
 * Skipped automatically when DATABASE_URL is not set so the plain unit-test
 * run stays green. The per-test isolation harness is a separate issue in
 * Epic #3; until it lands these tests hit the shared local database directly
 * (rows are suffixed with a run id and cleaned up in afterAll).
 */
const connectionString = process.env.DATABASE_URL ?? "";

/** Postgres error codes asserted below. */
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

async function pgErrorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    // drizzle-orm >= 0.44 wraps driver errors in DrizzleQueryError; the
    // postgres-js error carrying `.code` is on `.cause`. Check both so the
    // helper survives either shape.
    for (const candidate of [error, (error as Error).cause]) {
      const code = (candidate as { code?: string } | undefined)?.code;
      if (code) {
        return code;
      }
    }
    return "";
  }
  return "no error thrown";
}

describe.skipIf(!connectionString)("tenancy tables (integration)", () => {
  let db: Db;
  let sql: Sql;
  const runId = randomUUID().slice(0, 8);
  const createdPracticeIds: string[] = [];

  beforeAll(() => {
    ({ db, sql } = createDb(connectionString));
  });

  afterAll(async () => {
    if (createdPracticeIds.length > 0) {
      // Children first — FKs have no ON DELETE CASCADE (deliberately).
      await db
        .delete(providers)
        .where(inArray(providers.practiceId, createdPracticeIds));
      await db
        .delete(staffMembers)
        .where(inArray(staffMembers.practiceId, createdPracticeIds));
      await db
        .delete(locations)
        .where(inArray(locations.practiceId, createdPracticeIds));
      await db
        .delete(practices)
        .where(inArray(practices.id, createdPracticeIds));
    }
    await sql?.end();
  });

  async function insertPractice(suffix: string) {
    const [practice] = await db
      .insert(practices)
      .values({
        clerkOrgId: `org_${runId}_${suffix}`,
        name: `Test Practice ${suffix}`,
        slug: `test-practice-${runId}-${suffix}`,
      })
      .returning();
    if (!practice) throw new Error("practice insert returned no row");
    createdPracticeIds.push(practice.id);
    return practice;
  }

  it("inserts a practice, location, provider, and staff member and reads them back", async () => {
    const practice = await insertPractice("main");
    expect(practice.timezone).toBe("America/Chicago");
    expect(practice.createdAt).toBeInstanceOf(Date);
    expect(practice.updatedAt).toBeInstanceOf(Date);

    const [location] = await db
      .insert(locations)
      .values({ practiceId: practice.id, name: "Downtown" })
      .returning();
    if (!location) throw new Error("location insert returned no row");

    const [staffMember] = await db
      .insert(staffMembers)
      .values({
        practiceId: practice.id,
        clerkUserId: `user_${runId}_shah`,
        role: "provider",
        locationId: location.id,
        email: `shah+${runId}@example.com`,
      })
      .returning();
    if (!staffMember) throw new Error("staff member insert returned no row");
    expect(staffMember.deactivatedAt).toBeNull();

    const [provider] = await db
      .insert(providers)
      .values({
        practiceId: practice.id,
        locationId: location.id,
        displayName: "Dr. Shah",
        credentials: "DDS",
        staffMemberId: staffMember.id,
      })
      .returning();
    if (!provider) throw new Error("provider insert returned no row");
    expect(provider.active).toBe(true);

    const fetched = await db
      .select()
      .from(providers)
      .where(eq(providers.id, provider.id));
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.displayName).toBe("Dr. Shah");
    expect(fetched[0]?.staffMemberId).toBe(staffMember.id);

    const fetchedStaff = await db
      .select()
      .from(staffMembers)
      .where(eq(staffMembers.practiceId, practice.id));
    expect(fetchedStaff).toHaveLength(1);
    expect(fetchedStaff[0]?.role).toBe("provider");
  });

  it("rejects a duplicate clerk_org_id", async () => {
    const practice = await insertPractice("dup-org");
    const code = await pgErrorCode(
      db.insert(practices).values({
        clerkOrgId: practice.clerkOrgId,
        name: "Copycat Practice",
        slug: `copycat-${runId}`,
      }),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it("rejects a duplicate (practice_id, clerk_user_id) staff member, but allows the same user in a second practice", async () => {
    const practiceA = await insertPractice("staff-a");
    const practiceB = await insertPractice("staff-b");
    const clerkUserId = `user_${runId}_twopractices`;

    await db.insert(staffMembers).values({
      practiceId: practiceA.id,
      clerkUserId,
      email: `two+${runId}@example.com`,
    });

    const code = await pgErrorCode(
      db.insert(staffMembers).values({
        practiceId: practiceA.id,
        clerkUserId,
        email: `two-again+${runId}@example.com`,
      }),
    );
    expect(code).toBe(UNIQUE_VIOLATION);

    // One membership row per user per practice — a user in two practices
    // gets two rows.
    const [second] = await db
      .insert(staffMembers)
      .values({
        practiceId: practiceB.id,
        clerkUserId,
        email: `two+${runId}@example.com`,
      })
      .returning();
    expect(second?.practiceId).toBe(practiceB.id);
  });

  it("rejects a staff member with a nonexistent practice_id", async () => {
    const code = await pgErrorCode(
      db.insert(staffMembers).values({
        practiceId: randomUUID(),
        clerkUserId: `user_${runId}_orphan`,
        email: `orphan+${runId}@example.com`,
      }),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });
});
