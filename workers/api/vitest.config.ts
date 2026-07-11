import { configDefaults, defineConfig } from "vitest/config";

// Unit vs integration split (#40) — same per-workspace projects contract as
// packages/db/vitest.config.ts (see the rationale there):
//   - unit:        `**/*.test.ts` minus `**/*.integration.test.ts` — no DB,
//                  no network. JWT verification runs against locally signed
//                  test keys; svix signatures are generated in-test.
//   - integration: only `**/*.integration.test.ts` — real Postgres via
//                  DATABASE_URL, using packages/db's template-clone harness.
//
// Why plain vitest + `app.request()` instead of @cloudflare/vitest-pool-workers:
// nothing in this worker's auth surface is workerd-specific (Hono is
// runtime-agnostic, @clerk/backend's verifyToken and svix are pure
// WebCrypto/JS), while the DB tests depend on packages/db's node-side
// harness (node:fs/node:crypto template management, postgres-js over TCP)
// which cannot run inside the workers pool. No worker in this repo uses
// pool-workers yet; if a workerd-only surface appears (DO, queue consumer),
// introduce it then.
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
          include: [
            "src/**/*.integration.test.ts",
            "test/**/*.integration.test.ts",
          ],
          // Reuses packages/db's globalSetup: builds/refreshes the
          // wellregarded_template database once; each test file clones it
          // via setupTestDb() from the same harness.
          globalSetup: ["../../packages/db/test/globalSetup.ts"],
        },
      },
    ],
  },
});
