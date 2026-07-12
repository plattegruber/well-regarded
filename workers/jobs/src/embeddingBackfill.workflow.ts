/**
 * The `wr-embedding-backfill` Workflow entrypoint (issue #71) — the repo's
 * first real Cloudflare Workflow, so the pattern is settled here:
 *
 * - the class lives in its own module imported ONLY from src/worker.ts,
 *   because `cloudflare:workers` cannot resolve under plain Node and unit
 *   tests import the non-entry modules directly (same rule as SyncLock);
 * - the class stays paper-thin: it resolves params, wires real deps
 *   (Hyperdrive Postgres + Workers AI embedder), and delegates to
 *   `runEmbeddingBackfill` — ALL logic lives in ./embeddingBackfill.ts
 *   where Node tests can reach it;
 * - each batch opens its own DB connection inside its `step.do` and closes
 *   it before the step returns: a Workflow can sleep for minutes between
 *   steps and may resume in a different isolate, so nothing stateful may
 *   outlive a step;
 * - step callbacks must return JSON-serializable values (the engine
 *   persists them as checkpoints) — `BackfillBatchResult` is plain data.
 *
 * Missing bindings throw before the first step: the Workflows engine
 * retries steps, not the `run` preamble, and a misconfigured deploy should
 * fail the instance loudly rather than spin.
 *
 * Triggering (see docs/embedding-backfill.md): deployed, `npx wrangler
 * workflows trigger wr-embedding-backfill-<env> '{...params}'`; local,
 * `POST /__local/trigger/embedding-backfill` under `wrangler dev`.
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { createWorkersAiEmbedder } from "@wellregarded/ai";
import { createDb } from "@wellregarded/db";

import type { JobsBindings } from "./bindings";
import {
  type EmbeddingBackfillParams,
  type EmbeddingBackfillSummary,
  embedExcerptBatch,
  resolveBackfillParams,
  runEmbeddingBackfill,
} from "./embeddingBackfill";

export class EmbeddingBackfill extends WorkflowEntrypoint<
  JobsBindings,
  EmbeddingBackfillParams
> {
  override async run(
    event: WorkflowEvent<EmbeddingBackfillParams>,
    step: WorkflowStep,
  ): Promise<EmbeddingBackfillSummary> {
    const env = this.env;
    const hyperdrive = env.HYPERDRIVE;
    if (!hyperdrive) {
      throw new Error(
        "embedding-backfill: HYPERDRIVE binding is missing — the backfill " +
          "needs Postgres (see workers/jobs/wrangler.jsonc)",
      );
    }
    const ai = env.AI;
    if (!ai) {
      throw new Error(
        "embedding-backfill: AI binding is missing — the backfill needs " +
          "Workers AI for bge-m3 (see workers/jobs/wrangler.jsonc)",
      );
    }

    const params = resolveBackfillParams(event.payload);
    const embedder = createWorkersAiEmbedder(ai);

    return runEmbeddingBackfill(
      {
        do: (name, callback) => step.do(name, callback),
        sleep: (name, durationMs) => step.sleep(name, durationMs),
      },
      {
        processBatch: async (afterId) => {
          // Per-step connection: see the module doc.
          const { db, sql } = createDb(hyperdrive.connectionString);
          try {
            return await embedExcerptBatch(db, embedder, {
              practiceId: params.practiceId,
              afterId: afterId ?? undefined,
              batchSize: params.batchSize,
            });
          } finally {
            await sql.end({ timeout: 5 });
          }
        },
      },
      params,
    );
  }
}
