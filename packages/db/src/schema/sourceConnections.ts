/**
 * `source_connections` — a practice's OAuth-backed integrations (issue
 * #118, Epic #7). One row per (practice, kind); Google Business Profile is
 * the first kind, the enum stays open for future ones.
 *
 * Credential custody rules (ADR 0002 — `business.manage` grants full
 * profile management, so this column carries real weight):
 *
 * - `encrypted_credentials` holds AES-256-GCM ciphertext produced by
 *   `encryptField` in `@wellregarded/core` (`v<n>:<iv>:<ct>` format, keyring
 *   from Worker secrets) over the credential JSON
 *   (`GoogleConnectionCredentials`: `{ refreshToken, obtainedAt }`).
 *   NEVER-LOG(credentials): neither the plaintext nor the ciphertext may
 *   appear in logs, audit payloads, or API responses.
 * - Disconnect NULLs the column — dead tokens are never kept.
 * - Re-running connect on a `needs_reauth`/`disconnected` row replaces the
 *   credentials in place and restores `active` WITHOUT touching `metadata`
 *   (the #121 location mapping lives there and must survive re-auth).
 *
 * `unique (practice_id, kind)` is deliberate for now: one Google connection
 * per practice. Multi-connection-per-kind can relax it later.
 */

import {
  SOURCE_CONNECTION_KINDS,
  SOURCE_CONNECTION_STATUSES,
} from "@wellregarded/core";
import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { practices, staffMembers } from "./tenancy.js";

// Enum values sourced from @wellregarded/core (one source of truth shared
// with the workers' status handling).
export const sourceConnectionKindEnum = pgEnum(
  "source_connection_kind",
  SOURCE_CONNECTION_KINDS,
);

export const sourceConnectionStatusEnum = pgEnum(
  "source_connection_status",
  SOURCE_CONNECTION_STATUSES,
);

export const sourceConnections = pgTable(
  "source_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    kind: sourceConnectionKindEnum("kind").notNull(),
    status: sourceConnectionStatusEnum("status").notNull().default("active"),
    /**
     * AES-GCM ciphertext (`encryptField` format) of the credential JSON.
     * NULL exactly when `status = 'disconnected'` — never a dead token.
     */
    encryptedCredentials: text("encrypted_credentials"),
    /** OAuth scopes granted (ADR 0002: exactly `business.manage` today). */
    scopes: text("scopes").array().notNull(),
    /**
     * Who connected (or last re-authorized). Nullable: connections survive
     * their connector's staff row being deactivated.
     */
    connectedBy: uuid("connected_by").references(() => staffMembers.id),
    /** Stamped by the poller (#123) after each successful sync. */
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    /**
     * Integration-specific state that must survive re-auth — the #121
     * location mapping lives here (`googleLocations`, `mappings`, …).
     */
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("source_connections_practice_id_kind_unique").on(
      table.practiceId,
      table.kind,
    ),
    index("source_connections_practice_id_idx").on(table.practiceId),
  ],
);
