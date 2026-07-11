/**
 * API key verification queries (issue #81, Epic #4).
 *
 * `resolveApiKey` is on the PUBLIC hot path — every Proof API request runs
 * it. It must stay a single indexed query (UNIQUE on `api_keys.key_hash`,
 * one inner join to `practices` and nothing else) and must never `audit()`
 * per lookup — that would write a row per public search.
 *
 * Revocation is immediate: there is no cache, so the next lookup after
 * `revoked_at` is stamped misses. When Epic #14 adds KV caching of key
 * lookups, THAT issue owns the invalidation story — if you are adding a
 * cache here, go read it first.
 */

import { API_KEY_PATTERN, hashApiKey } from "@wellregarded/core";
import { eq } from "drizzle-orm";

import type { Db } from "../client.js";
import { apiKeys } from "../schema/apiKeys.js";
import { practices } from "../schema/tenancy.js";

export type ApiKey = typeof apiKeys.$inferSelect;

export interface ResolvedApiKey {
  apiKey: ApiKey;
  practice: typeof practices.$inferSelect;
}

/**
 * Resolve a presented key to its practice: hash the plaintext, look the
 * digest up on the UNIQUE `key_hash` index. Returns `null` for unknown,
 * revoked, or non-key-shaped input — callers (the `apiKeyAuth` middleware)
 * must not distinguish these cases in any response.
 *
 * Comparison is hash-equality via the index — constant-time-safe by
 * construction (no plaintext comparison ever happens; SHA-256 digest
 * equality leaks nothing about the preimage).
 */
export async function resolveApiKey(
  db: Db,
  key: string,
): Promise<ResolvedApiKey | null> {
  if (!API_KEY_PATTERN.test(key)) return null;
  const keyHash = await hashApiKey(key);
  const [row] = await db
    .select({ apiKey: apiKeys, practice: practices })
    .from(apiKeys)
    .innerJoin(practices, eq(apiKeys.practiceId, practices.id))
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);
  if (!row || row.apiKey.revokedAt !== null) return null;
  return row;
}

/**
 * Stamp `last_used_at` after a successful verification. Callers run this
 * OFF the request path (fire-and-forget via `executionCtx.waitUntil`) —
 * it is best-effort observability, and a failure here must never fail the
 * request. Single indexed UPDATE by primary key.
 */
export async function touchApiKeyLastUsed(
  db: Db,
  keyId: string,
  usedAt: Date = new Date(),
): Promise<void> {
  await db
    .update(apiKeys)
    .set({ lastUsedAt: usedAt })
    .where(eq(apiKeys.id, keyId));
}
