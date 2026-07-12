/**
 * Wrangler entrypoint for the jobs worker (see `main` in wrangler.jsonc).
 *
 * Kept separate from src/index.ts so unit tests — which run under Node, where
 * the `cloudflare:workers` runtime module cannot resolve — never import
 * runtime-only code. Exports:
 *
 * - `SyncLock` Durable Object (stub until Epic #20);
 * - `EmbeddingBackfill` Workflow (issue #71) — the class behind the
 *   `EMBEDDING_BACKFILL` binding / `wr-embedding-backfill-<env>` workflow;
 * - `CsvImport` Workflow (issue #135) — the class behind the
 *   `CSV_IMPORT` binding / `wr-csv-import-<env>` workflow;
 * - `fetch`: local-only debug triggers for the workflows (404 outside
 *   local).
 *
 * Real scheduled/queue handlers land in later epics.
 */

import type { JobsBindings } from "./bindings";
import { handleLocalTrigger } from "./localTrigger";

export { CsvImport } from "./csvImport.workflow";
export { EmbeddingBackfill } from "./embeddingBackfill.workflow";
export { SyncLock } from "./sync-lock";

export default {
  async fetch(request, env, _ctx) {
    return handleLocalTrigger(request, env);
  },
} satisfies ExportedHandler<JobsBindings>;
