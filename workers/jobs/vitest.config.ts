import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";
import { configDefaults, defineConfig } from "vitest/config";

// Three projects, following the workspace-wide unit/integration contract
// (see packages/db/vitest.config.ts for the rationale):
//
// - unit: plain Node, everything except `*.integration.test.ts` and
//   `*.worker.test.ts`. The backfill Workflow's logic and the GBP sync
//   engine (#123) keep `cloudflare:workers` out of their import graphs
//   (see src/worker.ts), so no workerd pool is needed for them.
//
// - workers: only `test/**/*.worker.test.ts`, inside workerd via
//   @cloudflare/vitest-pool-workers — the `SyncLock` Durable Object (#123)
//   only exists in workerd; these tests exercise real DO storage, RPC
//   stubs, and lock semantics. Runs with bindings from wrangler.jsonc's
//   top-level (local) block, EXCEPT Hyperdrive, which is overridden to a
//   deterministic dead end — no workerd test may touch a real database.
//   (Pinned to vitest-pool-workers 0.12.x like workers/pipeline: 0.13+
//   requires vitest 4; bump together with the workspace's vitest.)
//
// - integration: only `test/**/*.integration.test.ts`, in Node against a
//   real Postgres via packages/db's template-clone harness — the GBP sync
//   engine (#123) runs with its real drizzle store against real
//   `source_connections`/`import_runs` rows, driven by the fake GBP
//   server (#130) injected as `fetch`.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          exclude: [
            ...configDefaults.exclude,
            "**/*.integration.test.ts",
            "**/*.worker.test.ts",
          ],
        },
      },
      defineWorkersProject({
        test: {
          name: "workers",
          include: ["test/**/*.worker.test.ts"],
          poolOptions: {
            workers: {
              // Isolated (stacked) storage cannot snapshot SQLite-backed
              // Durable Objects (`.sqlite-shm` — a vitest-pool-workers
              // known issue), and `SyncLock` is SQLite-backed by design.
              // Tests isolate by using a distinct DO name per test instead.
              isolatedStorage: false,
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                // Deterministic dead end (RFC 6335 discard port): a workerd
                // test that accidentally reaches for Postgres fails loudly
                // instead of writing to whatever database a dev has running.
                hyperdrives: {
                  HYPERDRIVE:
                    "postgresql://workerd-tests-must-not-touch-postgres:x@127.0.0.1:9/none",
                },
                // Hermetic vars: pool-workers auto-loads `.dev.vars` (which
                // exists on dev machines but not CI), so pin the one var the
                // SyncLock failure-path test depends on. A keyring that
                // fails structural validation makes `runSync` fail fast and
                // deterministically BEFORE any socket is opened — the same
                // controlled failure with or without `.dev.vars`.
                bindings: {
                  PII_ENCRYPTION_KEYS: "workerd-tests-invalid-keyring",
                },
              },
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
