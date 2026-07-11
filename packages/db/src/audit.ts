/**
 * `audit()` — the one write path into `audit_log` (issue #46, Epic #3).
 *
 * Every mutation path in the codebase calls this at its meaningful action
 * boundary (consent change, publication, approval, patient-data access,
 * deletion). Explicit calls, not CDC or generic row triggers: the goal is a
 * log a human can read, not row-level diffs.
 */

import type { Actor } from "@wellregarded/core";

import type { Db } from "./client.js";
import { auditLog } from "./schema/audit.js";

/**
 * A Drizzle transaction handle for our client — accepted everywhere a `Db`
 * is, so helpers can participate in a caller's transaction.
 */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface AuditEntry {
  practiceId: string;
  /**
   * Who did it — the `Actor` union from `@wellregarded/core`, mirroring the
   * three Epic #4 auth surfaces (staff JWT, system jobs, patient link
   * tokens).
   */
  actor: Actor;
  /** Dot-namespaced `entity.verb`, e.g. `consent.granted`. */
  action: string;
  /** The table name acted upon, e.g. `consents`. */
  entityType: string;
  /** The row id acted upon. */
  entityId: string;
  /**
   * Before/after refs or minimal context — references and non-PII fields
   * only, never raw PII.
   */
  payload?: Record<string, unknown>;
}

/**
 * Append an audit row.
 *
 * **Same-transaction convention:** `db` may be a transaction handle, and
 * mutations MUST call `audit()` inside the same transaction as the change
 * they record — so an audit row cannot exist without its mutation, or the
 * mutation without its audit row. Rows are append-only (the
 * `audit_log_block_mutation` trigger rejects UPDATE/DELETE at the
 * database).
 */
export async function audit(db: Db | Tx, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    practiceId: entry.practiceId,
    actorType: entry.actor.type,
    actorId:
      entry.actor.type === "patient_token" ? entry.actor.jti : entry.actor.id,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    payload: entry.payload ?? null,
  });
}
