/**
 * Embedding backfill end-to-end against real Postgres (issue #71): seeded
 * `proof_excerpts` rows with NULL embeddings get embedded by the real
 * per-batch logic (`embedExcerptBatch`) under the real orchestration loop
 * (`runEmbeddingBackfill`) — with the deterministic fake embedder — and
 * the result is findable via `hybridSearch` with a paraphrase-style query
 * vector. Also proves resumability: a failed batch re-runs on the next
 * attempt while completed batches replay from their checkpoints.
 *
 * Run locally with:
 *
 *   docker compose up -d && pnpm --filter @wellregarded/jobs test:integration
 */

import {
  FAKE_EMBEDDING_MODEL,
  FakeEmbeddingProvider,
  fakeEmbed,
} from "@wellregarded/ai";
import {
  excerptsNeedingEmbedding,
  hybridSearch,
  schema,
} from "@wellregarded/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  practice,
  proofExcerpt,
  signal,
} from "../../../packages/db/test/factories.js";
import { setupTestDb } from "../../../packages/db/test/harness.js";
import {
  embedExcerptBatch,
  runEmbeddingBackfill,
} from "../src/embeddingBackfill";
import { FakeWorkflowStep } from "./support/fakeStep";

const { proofExcerpts } = schema;

const BILLING_TEXT =
  "The billing was confusing and nobody could tell me what I owed.";
const PARKING_TEXT = "Parking out front was easy and spacious.";
const HYGIENIST_TEXT = "The hygienist was gentle and quick with the cleaning.";

describe("embedding backfill (integration)", () => {
  const t = setupTestDb();

  async function seedExcerpts(texts: string[]) {
    const p = await practice(t.db);
    const parent = await signal(t.db, {
      practiceId: p.id,
      originalText: "Parent review text.",
    });
    const rows = [];
    for (const excerptText of texts) {
      rows.push(
        await proofExcerpt(t.db, {
          practiceId: p.id,
          signalId: parent.id,
          excerptText,
          embedding: null, // what the backfill exists to fix
        }),
      );
    }
    return { practiceId: p.id, rows };
  }

  function backfillDeps(embedder: FakeEmbeddingProvider, batchSize: number) {
    return {
      processBatch: (afterId: string | null) =>
        embedExcerptBatch(t.db, embedder, {
          afterId: afterId ?? undefined,
          batchSize,
        }),
    };
  }

  it("embeds seeded NULL rows, stamps embedding_model, and makes them findable by paraphrase via hybridSearch", async () => {
    const { practiceId, rows } = await seedExcerpts([
      BILLING_TEXT,
      PARKING_TEXT,
      HYGIENIST_TEXT,
    ]);
    const billingId = rows[0]?.id;
    const embedder = new FakeEmbeddingProvider();
    const step = new FakeWorkflowStep();

    const summary = await runEmbeddingBackfill(
      step,
      backfillDeps(embedder, 50),
      { practiceId: undefined, batchSize: 50, sleepMs: 0 },
    );
    expect(summary.embedded).toBe(3);

    // Every row now carries a vector and the model that produced it.
    for (const row of rows) {
      const [updated] = await t.db
        .select()
        .from(proofExcerpts)
        .where(eq(proofExcerpts.id, row.id));
      expect(updated?.embedding).toHaveLength(1024);
      expect(updated?.embeddingModel).toBe(FAKE_EMBEDDING_MODEL);
    }

    // Re-running is a no-op: the WHERE clause skips embedded rows.
    const secondRun = await runEmbeddingBackfill(
      new FakeWorkflowStep(),
      backfillDeps(embedder, 50),
      { practiceId: undefined, batchSize: 50, sleepMs: 0 },
    );
    expect(secondRun.embedded).toBe(0);

    // Paraphrase retrieval: the query shares vocabulary with the billing
    // excerpt (fakeEmbed is a hashed bag-of-words, so shared tokens =
    // cosine proximity) and must rank it first, vector branch only.
    const [queryEmbedding] = fakeEmbed([
      "billing was confusing about what I owed",
    ]);
    const results = await hybridSearch(t.db, {
      practiceId,
      queryEmbedding: queryEmbedding as number[],
      queryText: "",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.excerpt.id).toBe(billingId);
    expect(results[0]?.vectorRank).toBe(1);
  });

  it("resumes after a failed batch: completed batches replay from checkpoints, remaining rows still get embedded", async () => {
    const { rows } = await seedExcerpts([
      BILLING_TEXT,
      PARKING_TEXT,
      HYGIENIST_TEXT,
    ]);
    // Fail the SECOND embed call ever — i.e. batch 1 of the first attempt.
    const embedder = new FakeEmbeddingProvider({
      shouldFail: ({ index }) =>
        index === 1 ? new Error("Workers AI rate limited") : undefined,
    });
    const step = new FakeWorkflowStep();
    const deps = backfillDeps(embedder, 1); // one row per batch

    await expect(
      runEmbeddingBackfill(step, deps, {
        practiceId: undefined,
        batchSize: 1,
        sleepMs: 0,
      }),
    ).rejects.toThrow("rate limited");

    // Retry the instance against the same durable state.
    const summary = await runEmbeddingBackfill(step, deps, {
      practiceId: undefined,
      batchSize: 1,
      sleepMs: 0,
    });
    expect(summary.embedded).toBe(3);

    // Batch 0's row was embedded exactly once: its text appears in exactly
    // one successful embed call (the checkpoint replay never re-ran it),
    // and no row is left NULL.
    const embeddedTexts = embedder.calls.flat();
    const firstBatchText = embeddedTexts[0] as string;
    expect(
      embeddedTexts.filter((text) => text === firstBatchText),
    ).toHaveLength(1);
    for (const row of rows) {
      const [updated] = await t.db
        .select()
        .from(proofExcerpts)
        .where(eq(proofExcerpts.id, row.id));
      expect(updated?.embedding).not.toBeNull();
    }
  });

  it("re-embed hook: rows embedded by a different model still match the target query", async () => {
    const { practiceId, rows } = await seedExcerpts([BILLING_TEXT]);
    const embedder = new FakeEmbeddingProvider();
    await runEmbeddingBackfill(
      new FakeWorkflowStep(),
      backfillDeps(embedder, 50),
      { practiceId: undefined, batchSize: 50, sleepMs: 0 },
    );

    // Same model: nothing to do. Different target model: the row matches
    // again — this WHERE clause is the future model-migration hook (#71).
    // (Practice-scoped: the file's database is shared across its tests.)
    expect(
      await excerptsNeedingEmbedding(t.db, {
        targetModel: FAKE_EMBEDDING_MODEL,
        practiceId,
        limit: 10,
      }),
    ).toHaveLength(0);
    expect(
      await excerptsNeedingEmbedding(t.db, {
        targetModel: "@cf/some/newer-model",
        practiceId,
        limit: 10,
      }),
    ).toEqual([{ id: rows[0]?.id, excerptText: BILLING_TEXT }]);
  });
});
