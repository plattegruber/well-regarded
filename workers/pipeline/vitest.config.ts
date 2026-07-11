import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// This is the repo's first @cloudflare/vitest-pool-workers user (workers/api
// deliberately stayed on plain vitest — see its vitest.config.ts — because
// nothing there was workerd-specific and its integration tests need the
// node-side Postgres harness). The pipeline worker is the opposite case: its
// whole surface is a queue consumer, which only exists in workerd, and
// cloudflare:test's createMessageBatch/getQueueResult let tests assert real
// ack/retry outcomes instead of trusting fakes. All tests here run inside
// workerd with bindings from wrangler.jsonc (top-level block = local env:
// Miniflare queue simulators, ENVIRONMENT=local, no Cloudflare resources).
//
// Pinned to @cloudflare/vitest-pool-workers 0.12.x: 0.13+ requires vitest 4,
// and the workspace is on vitest 3.2.x. Bump both together.
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        // One workerd instance for all test files: the suite shares no
        // mutable state beyond console spies, and startup dominates runtime.
        singleWorker: true,
      },
    },
  },
});
