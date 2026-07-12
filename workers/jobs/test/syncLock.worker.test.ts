/**
 * `SyncLock` Durable Object tests inside workerd (issue #123 requirement
 * 2), via @cloudflare/vitest-pool-workers: real DO storage, real RPC
 * stubs, real per-instance serialization.
 *
 * Covered: acquire/release round trip, token-fenced release, rejection
 * while held (lock contention — `runSync` returns `already_running`
 * without touching any dependency), steal-after-TTL with a fresh token,
 * and release-in-finally even when the sync itself blows up. The sync
 * ENGINE's behavior is covered in src/gbpSync.test.ts and
 * test/gbpSync.integration.test.ts — here the engine only ever fails fast
 * (no Google vars, dead-end Hyperdrive), which is exactly what the
 * release-on-error path needs.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { SYNC_LOCK_STALE_MS } from "../src/gbpPolling";
import type { SyncLock, SyncLockRecord } from "../src/sync-lock";

// The test env carries the real DO namespace; the structural JobsBindings
// type deliberately widens it, so narrow back for stub calls.
function stub(name: string) {
  const namespace =
    env.SYNC_LOCK as unknown as DurableObjectNamespace<SyncLock>;
  return namespace.get(namespace.idFromName(name));
}

const input = {
  connectionId: "3f2b6a1e-90cd-4f5e-8a2f-1b0f4a7c9d21",
  trigger: "cron",
  requestId: "req-worker-test",
} as const;

describe("SyncLock.acquire/release", () => {
  it("acquires a free lock and releases it with the right token", async () => {
    const lock = stub("acquire-release");
    const acquired = await lock.acquire();
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired) throw new Error("unreachable");
    expect(acquired.stolen).toBe(false);

    const state = await lock.inspect();
    expect(state?.token).toBe(acquired.token);

    expect(await lock.release(acquired.token)).toBe(true);
    expect(await lock.inspect()).toBeNull();
  });

  it("rejects a second acquire while held, reporting hold duration", async () => {
    const lock = stub("contention");
    const first = await lock.acquire();
    expect(first.acquired).toBe(true);

    const second = await lock.acquire();
    expect(second.acquired).toBe(false);
    if (second.acquired) throw new Error("unreachable");
    expect(second.heldForMs).toBeGreaterThanOrEqual(0);
    expect(second.heldForMs).toBeLessThanOrEqual(SYNC_LOCK_STALE_MS);
  });

  it("release is token-fenced: a wrong token releases nothing", async () => {
    const lock = stub("fencing");
    const acquired = await lock.acquire();
    if (!acquired.acquired) throw new Error("unreachable");

    expect(await lock.release("not-the-token")).toBe(false);
    expect(await lock.inspect()).not.toBeNull();
    expect(await lock.release(acquired.token)).toBe(true);
  });

  it("steals a lock held past the stale TTL, minting a fresh token", async () => {
    const lock = stub("steal");
    // Plant a crashed holder: startedAt beyond the hard cap.
    await runInDurableObject(lock, async (_instance, state) => {
      const record: SyncLockRecord = {
        token: "zombie-token",
        startedAt: Date.now() - SYNC_LOCK_STALE_MS - 60_000,
      };
      await state.storage.put("lock", record);
    });

    const acquired = await lock.acquire();
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired) throw new Error("unreachable");
    expect(acquired.stolen).toBe(true);
    expect(acquired.token).not.toBe("zombie-token");
    expect(acquired.staleHeldForMs).toBeGreaterThan(SYNC_LOCK_STALE_MS);

    // The zombie's late release must NOT clobber the thief's lock.
    expect(await lock.release("zombie-token")).toBe(false);
    expect((await lock.inspect())?.token).toBe(acquired.token);
  });

  it("does NOT steal a lock still inside the TTL", async () => {
    const lock = stub("no-early-steal");
    await runInDurableObject(lock, async (_instance, state) => {
      const record: SyncLockRecord = {
        token: "live-token",
        startedAt: Date.now() - SYNC_LOCK_STALE_MS + 60_000,
      };
      await state.storage.put("lock", record);
    });
    const attempt = await lock.acquire();
    expect(attempt.acquired).toBe(false);
  });
});

describe("SyncLock.runSync", () => {
  it("rejects entry while a sync is in flight — no second sync starts", async () => {
    const lock = stub("runsync-contention");
    const held = await lock.acquire();
    expect(held.acquired).toBe(true);

    const result = await lock.runSync(input);
    expect(result.outcome).toBe("already_running");
    if (result.outcome !== "already_running") throw new Error("unreachable");
    expect(result.heldForMs).toBeGreaterThanOrEqual(0);

    // The rejected call must not have disturbed the holder's lock.
    if (!held.acquired) throw new Error("unreachable");
    expect((await lock.inspect())?.token).toBe(held.token);
  });

  it("releases the lock even when the sync run fails", async () => {
    const lock = stub("runsync-release-on-error");
    // In this test env the runtime wiring fails fast (the vitest config
    // pins an invalid PII keyring; Hyperdrive is a dead end) — a real
    // failure mode, and exactly the case where the finally-release must
    // still run. The DO reports it as a structured `error` outcome, never
    // an RPC throw.
    const result = await lock.runSync(input);
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") throw new Error("unreachable");
    expect(result.message.length).toBeGreaterThan(0);
    expect(await lock.inspect()).toBeNull();

    // And the lock is immediately usable again.
    const next = await lock.acquire();
    expect(next.acquired).toBe(true);
    if (next.acquired) await lock.release(next.token);
  });
});
