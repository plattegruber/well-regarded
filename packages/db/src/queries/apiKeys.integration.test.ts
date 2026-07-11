/**
 * resolveApiKey / touchApiKeyLastUsed against a real Postgres (issue #81):
 * the hash-lookup happy path, the null cases (unknown, revoked, malformed),
 * and the show-once storage invariant — the table never contains plaintext.
 */

import { generateApiKey } from "@wellregarded/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { apiKey, practice } from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import { apiKeys } from "../schema/apiKeys.js";
import { resolveApiKey, touchApiKeyLastUsed } from "./apiKeys.js";

const t = setupTestDb();

describe("resolveApiKey", () => {
  it("resolves a live key to its row and practice", async () => {
    const p = await practice(t.db);
    const created = await apiKey(t.db, { practiceId: p.id });

    const resolved = await resolveApiKey(t.db, created.key);
    expect(resolved).not.toBeNull();
    expect(resolved?.apiKey.id).toBe(created.id);
    expect(resolved?.apiKey.environment).toBe("live");
    expect(resolved?.practice.id).toBe(p.id);
    expect(resolved?.practice.slug).toBe(p.slug);
  });

  it("resolves a test key with its environment flag", async () => {
    const created = await apiKey(t.db, { environment: "test" });
    const resolved = await resolveApiKey(t.db, created.key);
    expect(resolved?.apiKey.environment).toBe("test");
  });

  it("returns null for a well-formed key that was never issued", async () => {
    await apiKey(t.db);
    const stranger = await generateApiKey("live");
    expect(await resolveApiKey(t.db, stranger.key)).toBeNull();
  });

  it("returns null for a revoked key", async () => {
    const created = await apiKey(t.db, { revokedAt: new Date() });
    expect(await resolveApiKey(t.db, created.key)).toBeNull();
  });

  it("returns null for non-key-shaped input without querying", async () => {
    expect(await resolveApiKey(t.db, "")).toBeNull();
    expect(await resolveApiKey(t.db, "zk_live_notours")).toBeNull();
    expect(await resolveApiKey(t.db, "pk_live_tooshort")).toBeNull();
  });

  it("the stored row holds the hash, never the plaintext", async () => {
    const created = await apiKey(t.db);
    const [row] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, created.id));
    expect(row?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(created.key);
  });
});

describe("touchApiKeyLastUsed", () => {
  it("stamps last_used_at for the key", async () => {
    const created = await apiKey(t.db);
    expect(created.lastUsedAt).toBeNull();

    const usedAt = new Date("2026-07-10T12:00:00Z");
    await touchApiKeyLastUsed(t.db, created.id, usedAt);

    const [row] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, created.id));
    expect(row?.lastUsedAt?.toISOString()).toBe(usedAt.toISOString());
  });
});
