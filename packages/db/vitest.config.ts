import { configDefaults, defineConfig } from "vitest/config";

// Unit vs integration split (#40).
//
// Issue #40's first choice is a repo-root Vitest projects config, but tests
// here run per-workspace through turbo (`test` depends on `^build`, and
// workspace package exports resolve to `dist/`), so a root-level vitest
// invocation would bypass turbo's build ordering and caching. We therefore
// use the sanctioned alternative: per-workspace projects with the identical
// file-glob contract, invoked via `turbo run test` / `turbo run
// test:integration`.
//
// The contract (same as the root approach would enforce):
//   - unit:        `**/*.test.ts` minus `**/*.integration.test.ts`
//                  — no DB, no network, runs anywhere with zero services.
//   - integration: only `**/*.integration.test.ts`
//                  — requires a real Postgres via DATABASE_URL. The canary
//                  test fails loudly (never skips) when DATABASE_URL is
//                  unset, so a misconfigured CI job cannot silently pass.
//
// Any workspace that grows `*.integration.test.ts` files must adopt this
// same projects config so its unit run keeps excluding them.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
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
          // Test harness (#49): globalSetup builds/refreshes the
          // wellregarded_template database once per run; each test file
          // clones it via setupTestDb() in test/harness.ts.
          globalSetup: ["./test/globalSetup.ts"],
        },
      },
    ],
  },
});
