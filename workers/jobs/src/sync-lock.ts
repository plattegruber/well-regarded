/**
 * `SyncLock` — the per-connection Durable Object behind the `SYNC_LOCK`
 * binding (issue #123, Epic #7; SQLite-backed, see the `migrations` block
 * in wrangler.jsonc). Replaces the empty stub from the binding-shape issue.
 *
 * One DO instance per source connection (`idFromName(connection.id)`), and
 * the DO **runs the sync itself** — the platform serializing calls into a
 * single instance is the whole overlap-prevention story: a slow poll can
 * never race the next cron tick (or a manual "Sync now") for the same
 * connection. Deliberately NO per-location fan-out DOs.
 *
 * Lock semantics (issue #123 requirement 2):
 * - `acquire` — takes the lock, or reports how long the current holder has
 *   held it. A holder older than {@link SYNC_LOCK_STALE_MS} is presumed
 *   crashed and is STOLEN (fresh token) — logged loudly by `runSync`.
 *   Residual risk, accepted at M1: a still-alive sync that legitimately
 *   outlives the cap (≈7,000 paced Google calls — far beyond any real
 *   practice) would briefly run concurrently with its thief; the token
 *   fences the lock, not the zombie's in-flight DB writes. The loud
 *   `lock_stolen` error log is the tripwire for revisiting the cap.
 * - `release(token)` — token-fenced: only the current holder's token
 *   releases, so a stolen-from zombie finishing late cannot clobber the
 *   thief's lock.
 * - `runSync` — acquire → run → release-in-finally. Rejected entry returns
 *   `already_running` (the manual endpoint maps it to "already syncing").
 *
 * State is minimal on purpose ({ token, startedAt } under one storage key):
 * everything durable — cursors, run stats, connection status — lives in
 * Postgres, so DO eviction costs nothing. An alarm-based watchdog is
 * overkill at M1; the stale-timestamp check above is the crash recovery.
 */

import { DurableObject } from "cloudflare:workers";
import {
  createLogger,
  getEnv,
  jobsEnvSchema,
  logLevelFor,
} from "@wellregarded/core";

import type { JobsBindings } from "./bindings";
import { SYNC_LOCK_STALE_MS } from "./gbpPolling";
import type { GbpSyncInput, GbpSyncOutcome } from "./gbpSync";
import { runGoogleConnectionSync } from "./gbpSyncRuntime";

/** The one storage record. */
export interface SyncLockRecord {
  /** Fencing token — a fresh UUID per acquisition. */
  token: string;
  /** ms since epoch when the holder acquired. */
  startedAt: number;
}

const LOCK_KEY = "lock";

export type SyncLockAcquireResult =
  | { acquired: true; token: string; stolen: boolean; staleHeldForMs?: number }
  | { acquired: false; heldForMs: number };

export type RunSyncResult =
  | { outcome: "already_running"; heldForMs: number }
  | {
      /** The run itself blew up (config/db/unexpected — already logged). */
      outcome: "error";
      message: string;
    }
  | GbpSyncOutcome;

export class SyncLock extends DurableObject<JobsBindings> {
  /**
   * Take the lock. Storage input gates make the get→put below atomic with
   * respect to other requests to this instance (no interleaving awaits).
   */
  async acquire(): Promise<SyncLockAcquireResult> {
    const now = Date.now();
    const current = await this.ctx.storage.get<SyncLockRecord>(LOCK_KEY);
    if (current !== undefined) {
      const heldForMs = now - current.startedAt;
      if (heldForMs <= SYNC_LOCK_STALE_MS) {
        return { acquired: false, heldForMs };
      }
      // Held past the hard cap: the holder crashed (or was torn down
      // without its finally running). Steal.
      const record: SyncLockRecord = {
        token: crypto.randomUUID(),
        startedAt: now,
      };
      await this.ctx.storage.put(LOCK_KEY, record);
      return {
        acquired: true,
        token: record.token,
        stolen: true,
        staleHeldForMs: heldForMs,
      };
    }
    const record: SyncLockRecord = {
      token: crypto.randomUUID(),
      startedAt: now,
    };
    await this.ctx.storage.put(LOCK_KEY, record);
    return { acquired: true, token: record.token, stolen: false };
  }

  /**
   * Release the lock iff `token` is the current holder's. Returns whether
   * anything was released — `false` from a finishing sync means its lock
   * was stolen mid-run (the thief already logged loudly).
   */
  async release(token: string): Promise<boolean> {
    const current = await this.ctx.storage.get<SyncLockRecord>(LOCK_KEY);
    if (current === undefined || current.token !== token) return false;
    await this.ctx.storage.delete(LOCK_KEY);
    return true;
  }

  /** Current lock state (observability + tests); null when free. */
  async inspect(): Promise<(SyncLockRecord & { heldForMs: number }) | null> {
    const current = await this.ctx.storage.get<SyncLockRecord>(LOCK_KEY);
    if (current === undefined) return null;
    return { ...current, heldForMs: Date.now() - current.startedAt };
  }

  /**
   * The one entry point cron and the manual "Sync now" endpoint share:
   * lock, sync, release. `already_running` is a normal outcome, not an
   * error — the caller (or the next tick) simply comes back later.
   */
  async runSync(input: GbpSyncInput): Promise<RunSyncResult> {
    const acquired = await this.acquire();
    const log = createLogger({
      worker: "jobs",
      requestId: input.requestId,
      stage: "sync-lock",
      level: logLevelFor(getEnv(this.env, jobsEnvSchema).ENVIRONMENT),
    });
    if (!acquired.acquired) {
      log.info("gbp.sync.lock_rejected", {
        connectionId: input.connectionId,
        trigger: input.trigger,
        heldForMs: acquired.heldForMs,
      });
      return { outcome: "already_running", heldForMs: acquired.heldForMs };
    }
    if (acquired.stolen) {
      // Requirement 2: a steal means a sync crashed without releasing —
      // an incident to look at, not routine noise.
      log.error("gbp.sync.lock_stolen", {
        connectionId: input.connectionId,
        trigger: input.trigger,
        staleHeldForMs: acquired.staleHeldForMs,
        staleCapMs: SYNC_LOCK_STALE_MS,
      });
    }
    try {
      return await runGoogleConnectionSync(this.env, input);
    } catch (error) {
      // Returned, not rethrown: a structured outcome crosses the RPC
      // boundary losslessly (a thrown error would arrive stringly-typed),
      // and callers treat it as "this run failed", not "the DO is broken".
      log.error("gbp.sync.run_failed", {
        connectionId: input.connectionId,
        trigger: input.trigger,
        error,
      });
      return {
        outcome: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await this.release(acquired.token);
    }
  }
}
