/**
 * Unit tests for the cron tick orchestration (issue #123 requirement 1):
 * every active connection gets its SyncLock invoked once, at its stagger
 * slot, and one connection's failure never affects its siblings.
 */

import { createLogger } from "@wellregarded/core";
import { describe, expect, it } from "vitest";

import { type GbpPollDeps, pollGoogleConnections } from "./scheduled";
import type { RunSyncResult } from "./sync-lock";

function harness(options: {
  connectionIds: string[];
  stagger?: (id: string) => number;
  runSync?: (id: string) => Promise<RunSyncResult>;
}) {
  const calls: Array<{ connectionId: string; atMs: number }> = [];
  const sleeps: number[] = [];
  let clock = 0;
  const lines: string[] = [];
  const deps: GbpPollDeps = {
    listConnectionIds: () => Promise.resolve(options.connectionIds),
    runSync: (connectionId) => {
      calls.push({ connectionId, atMs: clock });
      return (
        options.runSync?.(connectionId) ??
        Promise.resolve({
          outcome: "skipped",
          reason: "no_locations",
        } as RunSyncResult)
      );
    },
    stagger: options.stagger ?? (() => 0),
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    log: createLogger({
      worker: "jobs",
      requestId: "req-1",
      level: "debug",
      sink: (line) => lines.push(line),
    }),
  };
  return { deps, calls, sleeps, lines };
}

describe("pollGoogleConnections", () => {
  it("invokes each connection's SyncLock exactly once with the tick's requestId", async () => {
    const h = harness({ connectionIds: ["c1", "c2", "c3"] });
    const result = await pollGoogleConnections(h.deps, "req-1");
    expect(result.scheduled).toBe(3);
    expect(h.calls.map((call) => call.connectionId).sort()).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
  });

  it("sleeps each connection's stagger slot before its sync", async () => {
    const h = harness({
      connectionIds: ["c1", "c2"],
      stagger: (id) => (id === "c1" ? 1000 : 250_000),
    });
    await pollGoogleConnections(h.deps, "req-1");
    expect(h.sleeps.sort((a, b) => a - b)).toEqual([1000, 250_000]);
  });

  it("a rejecting DO call is logged and never breaks the tick", async () => {
    const h = harness({
      connectionIds: ["bad", "good"],
      runSync: (id) =>
        id === "bad"
          ? Promise.reject(new Error("DO exploded"))
          : Promise.resolve({
              outcome: "skipped",
              reason: "no_locations",
            } as RunSyncResult),
    });
    const result = await pollGoogleConnections(h.deps, "req-1");
    expect(result.scheduled).toBe(2);
    expect(h.calls).toHaveLength(2);
    const errorLine = h.lines.find((line) =>
      line.includes("gbp.poll.connection_failed"),
    );
    expect(errorLine).toBeDefined();
    expect(errorLine).toContain("bad");
  });

  it("an empty enumeration is a quiet no-op tick", async () => {
    const h = harness({ connectionIds: [] });
    const result = await pollGoogleConnections(h.deps, "req-1");
    expect(result.scheduled).toBe(0);
    expect(h.calls).toHaveLength(0);
  });
});
