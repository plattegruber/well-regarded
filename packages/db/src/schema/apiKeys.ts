/**
 * `api_keys` — publishable Proof API keys (issue #81, Epic #4).
 *
 * One row per key a practice ever created. The plaintext key is NEVER
 * stored — only `key_hash` (SHA-256 hex of the full key string; see
 * `@wellregarded/core`'s `apiKeys.ts` for why plain SHA-256 is correct
 * here and must not become a salted hash) plus `last4` as a display hint.
 *
 * Rows are never deleted: revocation stamps `revoked_at`, and the row
 * stays as audit history (and so a revoked key's hash keeps its UNIQUE
 * slot — a revoked credential can never be silently re-minted).
 *
 * The UNIQUE index on `key_hash` is the verification lookup path
 * (`resolveApiKey` in ../queries/apiKeys.ts — the public hot path);
 * the `practice_id` index serves the management list endpoint.
 *
 * `last_used_at` is a coarse observability hint ("is anything still using
 * this key?") maintained by a fire-and-forget UPDATE off the request path —
 * it is best-effort by design, never part of verification.
 */

import { API_KEY_ENVIRONMENTS } from "@wellregarded/core";
import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { practices, staffMembers } from "./tenancy.js";

// Enum values sourced from @wellregarded/core (one source of truth; key
// generation and the `ApiKeyActor` union consume the same constant).
export const apiKeyEnvironmentEnum = pgEnum(
  "api_key_environment",
  API_KEY_ENVIRONMENTS,
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    /** Human label, e.g. "Website embed". */
    name: text("name").notNull(),
    environment: apiKeyEnvironmentEnum("environment").notNull(),
    /** SHA-256 hex of the full key string — the verification lookup path. */
    keyHash: text("key_hash").notNull().unique(),
    /** Display hint for the key list UI; never enough to reconstruct a key. */
    last4: text("last4").notNull(),
    /** Nullable: keys survive their creator's staff row being deactivated. */
    createdBy: uuid("created_by").references(() => staffMembers.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set by the revoke endpoint; never unset, rows are never deleted. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Best-effort, touched fire-and-forget on successful verification. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [index("api_keys_practice_id_idx").on(table.practiceId)],
);
