import { DurableObject } from "cloudflare:workers";

/**
 * Durable Object backing the `SYNC_LOCK` binding (SQLite-backed, see the
 * `migrations` block in wrangler.jsonc).
 *
 * Empty stub on purpose: this issue (#28) only settles the binding shape and
 * migrations block. The real implementation — Open Dental sync locks — lands
 * in Epic #20.
 */
export class SyncLock extends DurableObject {}
