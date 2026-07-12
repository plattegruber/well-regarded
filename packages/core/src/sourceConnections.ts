/**
 * Source-connection vocabulary (issue #118, Epic #7) — the OAuth-backed
 * integrations a practice connects (Google Business Profile first). One
 * source of truth for the `source_connections` enums in `packages/db` and
 * for every consumer that branches on connection status.
 *
 * Distinct from `SOURCE_KINDS` (signals.ts) on purpose: a signal's
 * provenance (`csv_import`, `manual`, …) is not the same vocabulary as
 * "integrations that hold live credentials" — only kinds that carry an
 * OAuth/API credential belong here.
 */

export const SOURCE_CONNECTION_KINDS = ["google"] as const;
export type SourceConnectionKind = (typeof SOURCE_CONNECTION_KINDS)[number];

/**
 * - `active`        — credentials on file, last refresh worked.
 * - `needs_reauth`  — Google rejected the refresh token (`invalid_grant`:
 *   user revoked, Testing-status 7-day expiry, 6-months-unused, or the
 *   100-token cap — see ADR 0002 §4). Polling stops; the dashboard shows a
 *   Reconnect prompt. Re-running the connect flow restores `active`.
 * - `disconnected`  — staff disconnected; credentials are erased (the
 *   `encrypted_credentials` column is nulled, never kept dead).
 */
export const SOURCE_CONNECTION_STATUSES = [
  "active",
  "needs_reauth",
  "disconnected",
] as const;
export type SourceConnectionStatus =
  (typeof SOURCE_CONNECTION_STATUSES)[number];

/**
 * The credential JSON encrypted into `source_connections.encrypted_credentials`
 * (AES-GCM via `encryptField` — the shared util, never a second
 * implementation). NEVER-LOG(credentials): values of this shape must never
 * appear in logs, audit payloads, or API responses.
 */
export interface GoogleConnectionCredentials {
  refreshToken: string;
  /** ISO timestamp of the code exchange that produced the refresh token. */
  obtainedAt: string;
}
