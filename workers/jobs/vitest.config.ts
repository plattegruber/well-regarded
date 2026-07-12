import { configDefaults, defineConfig } from "vitest/config";

// Two projects, following the workspace-wide unit/integration contract
// (see packages/db/vitest.config.ts for the rationale):
//
// - unit: plain Node, everything except `*.integration.test.ts`. The
//   backfill Workflow's logic lives in src/embeddingBackfill.ts with the
//   `cloudflare:workers` entrypoint kept out of the import graph (see
//   src/worker.ts), so no workerd pool is needed here yet.
//
// - integration: only `test/**/*.integration.test.ts`, in Node against a
//   real Postgres via packages/db's template-clone harness — the backfill
//   batch logic runs against real `proof_excerpts` rows and hybridSearch.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
        },
      },
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
