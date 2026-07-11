/**
 * Runtime validation for the Clerk webhook payloads we consume
 * (issue #60). Schemas are deliberately minimal — only the fields the
 * sync reads — and non-strict, so additive changes on Clerk's side never
 * break the webhook. Parsing happens only AFTER svix signature
 * verification.
 */

import { z } from "zod";

/** The envelope every Clerk webhook event shares. */
export const clerkEventSchema = z.object({
  type: z.string().min(1),
  data: z.unknown(),
});

/** A Clerk organization object (top-level or nested in a membership). */
export const organizationDataSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
});
export type OrganizationData = z.infer<typeof organizationDataSchema>;

/** `public_user_data` nested in membership events. */
export const publicUserDataSchema = z.object({
  user_id: z.string().min(1),
  /** The user's identifier — their email address. */
  identifier: z.string().min(1),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
});
export type PublicUserData = z.infer<typeof publicUserDataSchema>;

/** `organizationMembership.*` event data. */
export const membershipDataSchema = z.object({
  organization: organizationDataSchema,
  public_user_data: publicUserDataSchema,
  role: z.string().min(1),
});
export type MembershipData = z.infer<typeof membershipDataSchema>;

/** `user.updated` event data. */
export const userDataSchema = z.object({
  id: z.string().min(1),
  email_addresses: z
    .array(z.object({ id: z.string(), email_address: z.string().min(1) }))
    .default([]),
  primary_email_address_id: z.string().nullish(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
});
export type UserData = z.infer<typeof userDataSchema>;
