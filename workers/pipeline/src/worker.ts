/**
 * Wrangler entrypoint (see `main` in wrangler.jsonc), kept separate from
 * src/index.ts: workerd only allows handler/Durable Object exports on the
 * entry module, and unit tests import the non-entry modules directly.
 *
 * - `queue`: all eight pipeline queues (four stages + four DLQs) land here;
 *   src/dispatch.ts routes on `batch.queue` and owns ack/retry semantics.
 * - `fetch`: local-only debug enqueue endpoint (404 outside local).
 */

import type { PipelineBindings } from "./bindings";
import { handleQueueBatch } from "./dispatch";
import { handleLocalEnqueue } from "./localEnqueue";

export default {
  async fetch(request, env, _ctx) {
    return handleLocalEnqueue(request, env);
  },
  async queue(batch, env, _ctx) {
    await handleQueueBatch(batch, env);
  },
} satisfies ExportedHandler<PipelineBindings>;
