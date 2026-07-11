/**
 * THE acceptance test for issue #111 requirement 4 — nothing fails
 * silently: a poison message that exhausts its retries must end up as
 * (a) a DLQ delivery, (b) a `recordPipelineFailure` write, and (c) visible
 * in `getImportRunSummary().errorSamples` — driven through the real
 * dispatcher's paths against a real Postgres.
 *
 * Retries themselves belong to Cloudflare Queues (`max_retries: 3` in
 * wrangler.jsonc): the dispatcher calls `message.retry()` and, once the
 * budget is spent, the platform delivers the BARE original body to the
 * stage's DLQ. This test drives exactly that sequence: three deliveries of
 * a message whose handler always throws (each must retry, never ack), then
 * the platform-style bare-body DLQ delivery, then the visibility assertions.
 */

import { RetryableError, resetEnvCache } from "@wellregarded/core";
import { getImportRunSummary } from "@wellregarded/db";
import { InMemoryRawArtifactBucket } from "@wellregarded/sources/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { importRun, practice } from "../../../packages/db/test/factories.js";
import { setupTestDb } from "../../../packages/db/test/harness.js";
import { handleQueueBatch, type StageHandlers } from "../src/dispatch";
import { stageHandlers } from "../src/stages";
import { fakeMessage, integrationEnv } from "./support/integrationEnv";

const t = setupTestDb();

const MAX_RETRIES = 3; // mirrors wrangler.jsonc's consumer config

beforeEach(() => {
  resetEnvCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("poison message acceptance (issue #111)", () => {
  it("a handler that always throws ends up visible in the import run's error samples", async () => {
    const p = await practice(t.db);
    const run = await importRun(t.db, {
      practiceId: p.id,
      sourceKind: "manual",
    });
    const env = integrationEnv(t.databaseName, new InMemoryRawArtifactBucket());

    const poisonBody = {
      importRunId: run.id,
      rawArtifactKey: `${p.id}/manual/poison.json`,
      sourceKind: "manual",
      practiceId: p.id,
    };
    const poisonedHandlers: StageHandlers = {
      ...stageHandlers,
      ingest: async () => {
        throw new RetryableError("poison: always fails");
      },
    };

    // Every delivery within the retry budget retries — never acks, never
    // silently drops.
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const message = fakeMessage(poisonBody);
      await handleQueueBatch(
        { queue: "wr-ingest", messages: [message] },
        env,
        poisonedHandlers,
      );
      expect(message.retry, `attempt ${attempt}`).toHaveBeenCalledOnce();
      expect(message.ack, `attempt ${attempt}`).not.toHaveBeenCalled();
    }

    // (a) DLQ delivery: after max_retries, Cloudflare Queues dead-letters
    // the BARE original body onto wr-ingest-dlq (no envelope). The real DLQ
    // consumer handles it...
    const dlqMessage = fakeMessage(poisonBody);
    await handleQueueBatch(
      { queue: "wr-ingest-dlq", messages: [dlqMessage] },
      env,
    );
    // ...and acks unconditionally (a DLQ consumer never retry-loops).
    expect(dlqMessage.ack).toHaveBeenCalledOnce();
    expect(dlqMessage.retry).not.toHaveBeenCalled();

    // (b) the recordPipelineFailure write landed: failed count incremented.
    // (c) and it is visible in getImportRunSummary().errorSamples with
    // stage + message + payload ref.
    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary).toBeDefined();
    expect(summary?.errorCount).toBe(1);
    expect(summary?.run.failed).toBe(1);
    expect(summary?.errorSamples).toHaveLength(1);
    expect(summary?.errorSamples[0]).toMatchObject({
      stage: "ingest",
      payloadRef: poisonBody.rawArtifactKey,
    });
    expect(summary?.errorSamples[0]?.message).toContain(
      "max_retries exhausted",
    );

    // The failure also stays out of the success tallies.
    expect(summary?.run.created).toBe(0);
    expect(summary?.totalProcessed).toBe(1);
  });

  it("a dispatcher-forwarded envelope (non-retryable) is equally visible", async () => {
    const p = await practice(t.db);
    const run = await importRun(t.db, {
      practiceId: p.id,
      sourceKind: "manual",
    });
    const env = integrationEnv(t.databaseName, new InMemoryRawArtifactBucket());

    // Missing artifact → the dispatcher forwards an envelope itself (no
    // retry budget burned) — the other road into the same DLQ.
    const body = {
      importRunId: run.id,
      rawArtifactKey: `${p.id}/manual/gone.json`,
      sourceKind: "manual",
      practiceId: p.id,
    };
    const mainMessage = fakeMessage(body);
    await handleQueueBatch(
      { queue: "wr-ingest", messages: [mainMessage] },
      env,
    );
    expect(mainMessage.ack).toHaveBeenCalledOnce();
    expect(env.INGEST_DLQ.sent).toHaveLength(1);

    const dlqMessage = fakeMessage(env.INGEST_DLQ.sent[0]);
    await handleQueueBatch(
      { queue: "wr-ingest-dlq", messages: [dlqMessage] },
      env,
    );

    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.errorCount).toBe(1);
    expect(summary?.errorSamples[0]).toMatchObject({ stage: "ingest" });
  });
});
