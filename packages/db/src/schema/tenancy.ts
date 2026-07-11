/**
 * Tenancy tables — the root of the data model (issue #33, Epic #3).
 *
 * Every other table carries a `practice_id` foreign key into `practices`,
 * and every query in the product is practice-scoped. Clerk owns
 * authentication (Clerk Organization = practice; Epic #4 syncs orgs and
 * memberships into these tables via webhooks), but locations, providers,
 * and role/permission data are ours.
 *
 * No row-level security in M0 — scoping is enforced by query helpers and
 * API middleware; every helper added in later issues takes `practiceId` as
 * its first argument.
 *
 * Ordering note: `staff_members` is declared before `providers` on purpose
 * (providers.staff_member_id references it) to keep drizzle-kit's migration
 * ordering deterministic.
 */

import { STAFF_ROLES } from "@wellregarded/core";
import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/** Shared `id` / `created_at` / `updated_at` columns for every tenancy table. */
const baseColumns = {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

/**
 * Staff role — values sourced from `STAFF_ROLES` in `@wellregarded/core`
 * (one source of truth; the Epic #4 permission matrix consumes the same
 * constant).
 */
export const staffRoleEnum = pgEnum("staff_role", STAFF_ROLES);

/**
 * A practice — the tenant. One row per Clerk Organization; `clerk_org_id`
 * is the join point for webhook sync and JWT resolution.
 */
export const practices = pgTable("practices", {
  ...baseColumns,
  clerkOrgId: text("clerk_org_id").notNull().unique(),
  name: text("name").notNull(),
  /** Used later by the Proof API. */
  slug: text("slug").notNull().unique(),
  timezone: text("timezone").notNull().default("America/Chicago"),
  websiteUrl: text("website_url"),
  phone: text("phone"),
  /** THROWAWAY — negative test (a) for the #55 migration gate; reverted. */
  driftCanary: text("drift_canary"),
});

/** A physical practice location. */
export const locations = pgTable(
  "locations",
  {
    ...baseColumns,
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    name: text("name").notNull(),
    // Address fields are nullable so factories can construct a location from
    // a name alone (requirement 7 — seed-friendly for the test harness).
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    state: text("state"),
    postalCode: text("postal_code"),
    /** GBP integration joins on this in Epic #7. */
    googlePlaceId: text("google_place_id"),
    phone: text("phone"),
  },
  (table) => [index("locations_practice_id_idx").on(table.practiceId)],
);

/**
 * The people who log in. One membership row per user per practice — a user
 * in two practices gets two rows.
 *
 * Webhook sync soft-deletes via `deactivated_at` on membership removal;
 * never hard-delete (`audit_log` and assignments reference staff). Beyond
 * `email`/`display_name` we store no Clerk-derived profile data — Clerk is
 * the source of truth; we keep only what queries and audit trails need.
 */
export const staffMembers = pgTable(
  "staff_members",
  {
    ...baseColumns,
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    clerkUserId: text("clerk_user_id").notNull(),
    // Defaulted (least-privileged everyday role) so factories can construct
    // rows without picking a role; webhook sync always sets it explicitly.
    role: staffRoleEnum("role").notNull().default("front_desk"),
    /**
     * Optional location scope: when set, the permission layer (Epic #4)
     * restricts this member to that location; NULL means all locations.
     */
    locationId: uuid("location_id").references(() => locations.id),
    email: text("email").notNull(),
    displayName: text("display_name"),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  },
  (table) => [
    unique("staff_members_practice_id_clerk_user_id_unique").on(
      table.practiceId,
      table.clerkUserId,
    ),
    index("staff_members_clerk_user_id_idx").on(table.clerkUserId),
    index("staff_members_practice_id_idx").on(table.practiceId),
  ],
);

/**
 * The people patients talk about — display entities, not logins.
 * `staff_member_id` is set when a provider also logs in.
 */
export const providers = pgTable(
  "providers",
  {
    ...baseColumns,
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    /** Primary location. */
    locationId: uuid("location_id").references(() => locations.id),
    /** e.g. "Dr. Shah". */
    displayName: text("display_name").notNull(),
    fullName: text("full_name"),
    /** e.g. "DDS". */
    credentials: text("credentials"),
    bio: text("bio"),
    /** R2 object key. */
    photoKey: text("photo_key"),
    active: boolean("active").notNull().default(true),
    staffMemberId: uuid("staff_member_id").references(() => staffMembers.id),
  },
  (table) => [index("providers_practice_id_idx").on(table.practiceId)],
);
