// Deliberately separate from vite.config.ts: the app's Vite config loads the
// react-router and cloudflare plugins, which expect a full dev-server/build
// pipeline and break under Vitest. Unit tests here are plain Node tests
// (loaders as functions, components via renderToString) — the real Workers
// runtime is exercised by `pnpm dev` and, later in this epic, Playwright.
import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    // Mirror the `~` path alias from tsconfig.json.
    alias: {
      "~": new URL("./app", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    include: ["app/**/*.test.{ts,tsx}"],
  },
});
