import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";
import { configDefaults, defineConfig } from "vitest/config";

// Two projects, following the workspace-wide unit/integration contract
// (see packages/db/vitest.config.ts for the rationale):
//
// - unit: everything except `*.integration.test.ts`, inside workerd via
//   @cloudflare/vitest-pool-workers — the queue consumer only exists in
//   workerd, and cloudflare:test's createMessageBatch/getQueueResult let
//   tests assert real ack/retry outcomes instead of trusting fakes. Runs
//   with bindings from wrangler.jsonc's top-level (local) block: Miniflare
//   queue + R2 simulators, no Cloudflare resources, and — deliberately — a
//   Hyperdrive connection string that fails fast (no unit test may touch a
//   real database; the DLQ consumer's failure path is asserted instead).
//
// - integration: only `test/**/*.integration.test.ts`, in plain Node
//   against a real Postgres via packages/db's template-clone harness (the
//   same cross-package reuse as workers/api). These drive the dispatcher
//   directly with structural fakes for queue/R2/Hyperdrive bindings —
//   dispatch.ts is typed structurally for exactly this reason.
//
// Pinned to @cloudflare/vitest-pool-workers 0.12.x: 0.13+ requires vitest 4,
// and the workspace is on vitest 3.2.x. Bump both together.
export default defineConfig({
  test: {
    projects: [
      defineWorkersProject({
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
          poolOptions: {
            workers: {
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                // Deterministic dead end (RFC 6335 discard port): connection
                // attempts fail fast everywhere, so a unit test that
                // accidentally reaches for Postgres fails loudly instead of
                // writing to whatever database a dev has running.
                hyperdrives: {
                  HYPERDRIVE:
                    "postgresql://unit-tests-must-not-touch-postgres:x@127.0.0.1:9/none",
                },
              },
              // One workerd instance for all test files: the suite shares no
              // mutable state beyond console spies and the adapter registry,
              // and startup dominates runtime.
              singleWorker: true,
            },
          },
        },
      }),
      {
        test: {
          name: "integration",
          include: ["test/**/*.integration.test.ts"],
          // Reuses packages/db's globalSetup: builds/refreshes the
          // wellregarded_template database once; each test file clones it
          // via setupTestDb() from the same harness.
          globalSetup: ["../../packages/db/test/globalSetup.ts"],
        },
      },
    ],
  },
});
