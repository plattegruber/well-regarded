/**
 * The `wr-reply-import-backfill` Workflow entrypoint (issue #214) —
 * follows the settled Workflow pattern from `EmbeddingBackfill` (#71):
 *
 * - the class lives in its own module imported ONLY from src/worker.ts
 *   (`cloudflare:workers` cannot resolve under plain Node);
 * - it stays paper-thin: resolve params, wire real deps (Hyperdrive
 *   Postgres + the raw-artifacts R2 bucket), delegate to
 *   `runReplyImportBackfill` — ALL logic lives in ./replyImportBackfill.ts
 *   where Node tests can reach it;
 * - each batch opens its own DB connection inside its `step.do` and
 *   closes it before the step returns (nothing stateful may outlive a
 *   step);
 * - step callbacks return JSON-serializable checkpoints
 *   (`ReplyImportBatchResult` is plain data).
 *
 * Missing bindings throw before the first step: a misconfigured deploy
 * should fail the instance loudly rather than spin.
 *
 * Triggering: deployed, `npx wrangler workflows trigger
 * wr-reply-import-backfill-<env> '{"practiceId": "..."}'`; local,
 * `POST /__local/trigger/reply-import-backfill` under `wrangler dev`.
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { createDb } from "@wellregarded/db";

import type { JobsBindings } from "./bindings";
import {
  importRepliesBatch,
  type ReplyImportBackfillParams,
  type ReplyImportBackfillSummary,
  resolveReplyImportParams,
  runReplyImportBackfill,
} from "./replyImportBackfill";

export class ReplyImportBackfill extends WorkflowEntrypoint<
  JobsBindings,
  ReplyImportBackfillParams
> {
  override async run(
    event: WorkflowEvent<ReplyImportBackfillParams>,
    step: WorkflowStep,
  ): Promise<ReplyImportBackfillSummary> {
    const env = this.env;
    const hyperdrive = env.HYPERDRIVE;
    if (!hyperdrive) {
      throw new Error(
        "reply-import-backfill: HYPERDRIVE binding is missing — the " +
          "backfill needs Postgres (see workers/jobs/wrangler.jsonc)",
      );
    }
    const bucket = env.RAW_ARTIFACTS;
    if (!bucket) {
      throw new Error(
        "reply-import-backfill: RAW_ARTIFACTS binding is missing — the " +
          "backfill re-reads stored review pages (see workers/jobs/wrangler.jsonc)",
      );
    }

    const params = resolveReplyImportParams(event.payload);

    return runReplyImportBackfill(
      {
        do: (name, callback) => step.do(name, callback),
        sleep: (name, durationMs) => step.sleep(name, durationMs),
      },
      {
        processBatch: async (afterId) => {
          // Per-step connection: see the module doc.
          const { db, sql } = createDb(hyperdrive.connectionString);
          try {
            return await importRepliesBatch(db, bucket, {
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
