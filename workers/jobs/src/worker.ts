/**
 * Wrangler entrypoint for the jobs worker (see `main` in wrangler.jsonc).
 *
 * Kept separate from src/index.ts so unit tests — which run under Node, where
 * the `cloudflare:workers` runtime module cannot resolve — never import
 * runtime-only code. Handlers (fetch/scheduled/queue) land in later epics.
 */
export { SyncLock } from "./sync-lock";

// Placeholder module-worker export so wrangler builds this as an ES module —
// required for the SyncLock Durable Object (service-worker format cannot host
// DOs). Real handlers (fetch/scheduled/queue) land in later epics.
export default {};
