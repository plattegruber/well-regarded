/**
 * The 6-hourly GBP poll tick (issue #123 requirement 1): enumerate active
 * Google connections and hand each to its `SyncLock` DO — staggered, never
 * as a synchronized burst (spike #117; math in ./gbpPolling.ts).
 *
 * Split like the pipeline dispatcher: `pollGoogleConnections` is the pure
 * orchestration over injectable deps (Node-unit-testable), and
 * `handleScheduled` wires the real bindings. The scheduled handler AWAITS
 * the whole tick (stagger sleeps included): a 5-minute stagger window plus
 * paced syncs sits comfortably inside the platform's 15-minute wall-clock
 * allowance at M1 scale — revisit alongside the ~1,000-connection row of
 * the ADR Appendix A table.
 *
 * requestId: cron has no inbound request, so one fresh UUID is minted per
 * tick and stamped on every ingest message the tick produces (issue #64's
 * cron convention) — one grep follows the whole tick across workers.
 */

import {
  createLogger,
  getEnv,
  jobsEnvSchema,
  type Logger,
  logLevelFor,
} from "@wellregarded/core";
import { createDb, listActiveSourceConnections } from "@wellregarded/db";

import type { JobsBindings, SyncLockNamespace } from "./bindings";
import { connectionStaggerMs, GBP_POLL_CRON } from "./gbpPolling";
import type { RunSyncResult } from "./sync-lock";

export interface GbpPollDeps {
  /** Ids of every `active` google connection. */
  listConnectionIds(): Promise<string[]>;
  /** Invoke the connection's `SyncLock` DO. */
  runSync(connectionId: string, requestId: string): Promise<RunSyncResult>;
  /** Stagger slot for a connection (injectable for tests). */
  stagger(connectionId: string): number;
  sleep(ms: number): Promise<void>;
  log: Logger;
}

/**
 * One poll tick: every connection is scheduled at its stagger slot, all
 * syncs run under their own DO lock, and the tick resolves when the last
 * one finishes. A connection failing (or being locked) never affects its
 * siblings — outcomes are logged per connection.
 */
export async function pollGoogleConnections(
  deps: GbpPollDeps,
  requestId: string,
): Promise<{ scheduled: number }> {
  const connectionIds = await deps.listConnectionIds();
  deps.log.info("gbp.poll.tick", { connections: connectionIds.length });

  await Promise.all(
    connectionIds.map(async (connectionId) => {
      const staggerMs = deps.stagger(connectionId);
      deps.log.debug("gbp.poll.scheduled", { connectionId, staggerMs });
      try {
        await deps.sleep(staggerMs);
        const result = await deps.runSync(connectionId, requestId);
        deps.log.info("gbp.poll.connection_done", {
          connectionId,
          outcome: result.outcome,
        });
      } catch (error) {
        // A DO invocation failing outright (not a sync error — those are
        // handled inside) — log and move on; the next tick retries.
        deps.log.error("gbp.poll.connection_failed", { connectionId, error });
      }
    }),
  );
  return { scheduled: connectionIds.length };
}

function requireBinding<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(
      `${name} binding is missing — the GBP poll cron cannot run. Check ` +
        "wrangler.jsonc (workers/jobs); bindings are NOT inherited across envs.",
    );
  }
  return value;
}

/** The worker's `scheduled` handler body (see src/worker.ts). */
export async function handleScheduled(
  controller: { cron: string },
  env: JobsBindings,
): Promise<void> {
  const vars = getEnv(env, jobsEnvSchema);
  const requestId = crypto.randomUUID();
  const log = createLogger({
    worker: "jobs",
    requestId,
    stage: "gbp-poll-cron",
    level: logLevelFor(vars.ENVIRONMENT),
  });

  // Dispatch on the cron expression, like the pipeline dispatches on
  // batch.queue: today there is exactly one schedule; a second job's cron
  // must add its own branch here, not piggyback. An empty string (some
  // local --test-scheduled invocations) is treated as the GBP poll.
  if (controller.cron !== "" && controller.cron !== GBP_POLL_CRON) {
    log.error("jobs.scheduled.unknown_cron", { cron: controller.cron });
    return;
  }

  const hyperdrive = requireBinding(env.HYPERDRIVE, "HYPERDRIVE");
  const syncLock: SyncLockNamespace = requireBinding(
    env.SYNC_LOCK,
    "SYNC_LOCK",
  );

  // Short-lived client for the enumeration only — each sync opens its own
  // (in the DO), so the tick never holds a connection across staggers.
  const { db, sql } = createDb(hyperdrive.connectionString);
  let connectionIds: string[];
  try {
    const connections = await listActiveSourceConnections(db, "google");
    connectionIds = connections.map((connection) => connection.id);
  } finally {
    await sql.end({ timeout: 5 });
  }

  await pollGoogleConnections(
    {
      listConnectionIds: () => Promise.resolve(connectionIds),
      runSync: (connectionId, reqId) =>
        syncLock.get(syncLock.idFromName(connectionId)).runSync({
          connectionId,
          trigger: "cron",
          requestId: reqId,
        }),
      stagger: (connectionId) => connectionStaggerMs(connectionId),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log,
    },
    requestId,
  );
}
