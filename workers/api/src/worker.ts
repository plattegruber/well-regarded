/**
 * Wrangler entrypoint (see `main` in wrangler.jsonc), kept separate from
 * src/index.ts: workerd only allows handler/Durable Object exports on the
 * entry module, and unit tests run under Node where runtime-only modules
 * don't resolve.
 *
 * Placeholder module-worker export so wrangler builds this as an ES module.
 * Real handlers (fetch/queue/scheduled) land in later epics — issue #28 is
 * config only.
 */
export default {};
