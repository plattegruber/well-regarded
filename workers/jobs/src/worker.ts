/**
 * Wrangler entrypoint for the jobs worker (see `main` in wrangler.jsonc).
 *
 * Kept separate from src/index.ts so unit tests — which run under Node, where
 * the `cloudflare:workers` runtime module cannot resolve — never import
 * runtime-only code. Exports:
 *
 * - `SyncLock` Durable Object (issue #123) — per-connection GBP sync lock
 *   AND runner (`runSync` is the entry point cron and the manual "Sync
 *   now" endpoint share);
 * - `EmbeddingBackfill` Workflow (issue #71) — the class behind the
 *   `EMBEDDING_BACKFILL` binding / `wr-embedding-backfill-<env>` workflow;
 * - `CsvImport` Workflow (issue #135) — the class behind the
 *   `CSV_IMPORT` binding / `wr-csv-import-<env>` workflow;
 * - `scheduled`: the 6-hourly GBP poll tick (issue #123; src/scheduled.ts).
 *   Test locally with `wrangler dev --test-scheduled` and
 *   `curl "http://localhost:8789/cdn-cgi/handler/scheduled?cron=0+*%2F6+*+*+*"`;
 * - `queue`: the publish-response consumer (issue #82) —
 *   `wr-publish-response` messages from the dashboard's approve/retry
 *   actions, published to GBP via the Epic #7 capability;
 * - `fetch`: local-only debug triggers for the workflows (404 outside
 *   local).
 */

import type { JobsBindings } from "./bindings";
import { handleLocalTrigger } from "./localTrigger";
import { handlePublishResponseBatch } from "./publishResponseRuntime";
import { handleScheduled } from "./scheduled";

export { CsvImport } from "./csvImport.workflow";
export { EmbeddingBackfill } from "./embeddingBackfill.workflow";
export { SyncLock } from "./sync-lock";

export default {
  async fetch(request, env, _ctx) {
    return handleLocalTrigger(request, env);
  },
  async scheduled(controller, env, _ctx) {
    await handleScheduled(controller, env);
  },
  // The publish-response consumer (issue #82). Lives here — not
  // workers/pipeline — because this worker already holds the Google OAuth
  // secrets, PII keyring, and #118 token provider a GBP call needs.
  async queue(batch, env, _ctx) {
    await handlePublishResponseBatch(batch, env);
  },
} satisfies ExportedHandler<JobsBindings>;
