/**
 * Reply-import backfill end-to-end against real Postgres (issue #214):
 * already-ingested Google signals whose stored artifacts carry
 * pre-existing owner replies get imported `responses` rows via the real
 * per-batch logic (`importRepliesBatch`) under the real orchestration
 * loop (`runReplyImportBackfill`) with an in-memory R2 bucket. Covers the
 * recorded-fixture path (factories + the #130 recorded reviews page), the
 * skip-and-count posture for missing artifacts, and the SEEDED corpus
 * (`runSeed` + `demoGoogleArtifacts`, the #214 backfill-over-seed check).
 *
 * Run locally with:
 *
 *   docker compose up -d && pnpm --filter @wellregarded/jobs test:integration
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { countReviewInboxStatuses, schema } from "@wellregarded/db";
import { putRawArtifact } from "@wellregarded/sources";
import { InMemoryRawArtifactBucket } from "@wellregarded/sources/testing";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { demoGoogleArtifacts } from "../../../packages/db/src/seed/fixtures/googleArtifacts.js";
import { SIGNAL_FIXTURES } from "../../../packages/db/src/seed/fixtures/signals.js";
import {
  DEMO_PRACTICE_ID,
  runSeed,
} from "../../../packages/db/src/seed/run.js";
import { practice, signal } from "../../../packages/db/test/factories.js";
import { setupTestDb } from "../../../packages/db/test/harness.js";
import {
  importRepliesBatch,
  type ResolvedReplyImportParams,
  runReplyImportBackfill,
} from "../src/replyImportBackfill";
import { FakeWorkflowStep } from "./support/fakeStep";

const { responses, auditLog } = schema;

interface RecordedReview {
  name: string;
  reviewReply?: {
    comment: string;
    updateTime?: string;
    reviewReplyState?: string;
    policyViolation?: string;
  };
}

async function loadRecordedPage(): Promise<{ reviews: RecordedReview[] }> {
  return JSON.parse(
    await readFile(
      fileURLToPath(
        new URL(
          "../../../packages/sources/src/google/fixtures/reviews.list.page1.json",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  );
}

describe("reply-import backfill (integration)", () => {
  const t = setupTestDb();

  function params(
    overrides: Partial<ResolvedReplyImportParams> = {},
  ): ResolvedReplyImportParams {
    return { practiceId: undefined, batchSize: 4, sleepMs: 0, ...overrides };
  }

  function backfillDeps(
    bucket: InMemoryRawArtifactBucket,
    p: ResolvedReplyImportParams,
  ) {
    return {
      processBatch: (afterId: string | null) =>
        importRepliesBatch(t.db, bucket, {
          practiceId: p.practiceId,
          afterId: afterId ?? undefined,
          batchSize: p.batchSize,
        }),
    };
  }

  async function importedResponses(practiceId: string) {
    return t.db
      .select()
      .from(responses)
      .where(
        and(
          eq(responses.practiceId, practiceId),
          eq(responses.origin, "source_import"),
        ),
      );
  }

  it("imports every replied review from a stored page for already-ingested signals, batched and idempotent", async () => {
    const p = await practice(t.db);
    const bucket = new InMemoryRawArtifactBucket();
    const page = await loadRecordedPage();
    // The page exactly as the poller (#123) stored it, content-addressed.
    const { key } = await putRawArtifact(bucket, {
      practiceId: p.id,
      sourceKind: "google",
      content: JSON.stringify({
        kind: "gbp.reviews.page",
        envelopeVersion: 1,
        practiceId: p.id,
        googleLocationName: "accounts/1/locations/1",
        fetchedAt: "2026-07-01T00:00:00.000Z",
        page,
      }),
    });
    // The signals were ingested BEFORE #214's normalize seam existed: rows
    // reference the artifact, but no responses were written.
    const idsByName = new Map<string, string>();
    for (const review of page.reviews) {
      const row = await signal(t.db, {
        practiceId: p.id,
        sourceKind: "google",
        sourceId: review.name,
        visibility: "public",
        rawArtifactKey: key,
      });
      idsByName.set(review.name, row.id);
    }
    const replied = page.reviews.filter((r) => r.reviewReply !== undefined);
    expect(replied.length).toBeGreaterThan(0);

    const scoped = params({ practiceId: p.id }); // batchSize 4 → many batches
    const summary = await runReplyImportBackfill(
      new FakeWorkflowStep(),
      backfillDeps(bucket, scoped),
      scoped,
    );
    expect(summary).toMatchObject({
      scanned: page.reviews.length,
      withReply: replied.length,
      imported: replied.length,
      updated: 0,
      unchanged: 0,
      artifactsMissing: 0,
      artifactsFailed: 0,
    });
    expect(summary.batches).toBe(Math.ceil(page.reviews.length / 4));

    // Rows: one per replied review, published/source_import/authorless,
    // moderation state carried, published_at = the reply's updateTime.
    const rows = await importedResponses(p.id);
    expect(rows).toHaveLength(replied.length);
    for (const review of replied) {
      const row = rows.find((r) => r.signalId === idsByName.get(review.name));
      expect(row).toMatchObject({
        origin: "source_import",
        status: "published",
        authorId: null,
        body: review.reviewReply?.comment,
        moderationState: review.reviewReply?.reviewReplyState ?? null,
        policyViolation: review.reviewReply?.policyViolation ?? null,
        publishUpdateTime: review.reviewReply?.updateTime ?? null,
      });
    }

    // Audited with the backfill's system actor and provenance payload.
    const audits = (
      await t.db.select().from(auditLog).where(eq(auditLog.practiceId, p.id))
    ).filter((a) => a.action === "response.imported");
    expect(audits).toHaveLength(replied.length);
    for (const entry of audits) {
      expect(entry).toMatchObject({
        actorType: "system",
        actorId: "jobs:reply-import-backfill",
      });
      expect(entry.payload).toMatchObject({
        backfill: true,
        rawArtifactKey: key,
      });
    }

    // The imported replies flip the inbox to responded (#214 req 3).
    const counts = await countReviewInboxStatuses(t.db, { practiceId: p.id });
    expect(counts.responded).toBe(replied.length);

    // Re-running the whole backfill is a no-op: everything unchanged.
    const second = await runReplyImportBackfill(
      new FakeWorkflowStep(),
      backfillDeps(bucket, scoped),
      scoped,
    );
    expect(second).toMatchObject({
      imported: 0,
      updated: 0,
      unchanged: replied.length,
    });
    expect(await importedResponses(p.id)).toHaveLength(replied.length);
  });

  it("counts a missing artifact, skips its signals, and still imports the rest", async () => {
    const p = await practice(t.db);
    const bucket = new InMemoryRawArtifactBucket();
    const page = await loadRecordedPage();
    const replied = page.reviews.filter((r) => r.reviewReply !== undefined);
    const target = replied[0];
    if (!target) throw new Error("recorded page lost its replied reviews");

    const { key } = await putRawArtifact(bucket, {
      practiceId: p.id,
      sourceKind: "google",
      content: JSON.stringify({
        kind: "gbp.reviews.page",
        envelopeVersion: 1,
        practiceId: p.id,
        googleLocationName: "accounts/1/locations/1",
        fetchedAt: "2026-07-01T00:00:00.000Z",
        page: { reviews: [target] },
      }),
    });
    await signal(t.db, {
      practiceId: p.id,
      sourceKind: "google",
      sourceId: target.name,
      visibility: "public",
      rawArtifactKey: key,
    });
    // A signal whose artifact was never stored (or aged out) — the
    // backfill must count it and move on, never wedge.
    await signal(t.db, {
      practiceId: p.id,
      sourceKind: "google",
      sourceId: "accounts/1/locations/1/reviews/gone",
      visibility: "public",
      rawArtifactKey: `${p.id}/google/never-stored.json`,
    });

    const scoped = params({ practiceId: p.id, batchSize: 10 });
    const summary = await runReplyImportBackfill(
      new FakeWorkflowStep(),
      backfillDeps(bucket, scoped),
      scoped,
    );
    expect(summary).toMatchObject({
      scanned: 2,
      withReply: 1,
      imported: 1,
      artifactsMissing: 1,
    });
    expect(await importedResponses(p.id)).toHaveLength(1);
  });

  it("over the seeded corpus: seed v3 rows read unchanged; wiped rows are re-imported; an edited artifact updates in place", async () => {
    await runSeed(t.db);
    const bucket = new InMemoryRawArtifactBucket();
    const encoder = new TextEncoder();
    for (const { key, artifact } of demoGoogleArtifacts(DEMO_PRACTICE_ID)) {
      await bucket.put(key, encoder.encode(JSON.stringify(artifact)));
    }
    const repliedFixtures = SIGNAL_FIXTURES.filter(
      (f) => f.existingReply !== undefined,
    );
    const googleCount = SIGNAL_FIXTURES.filter(
      (f) => f.sourceKind === "google",
    ).length;
    const scoped = params({ practiceId: DEMO_PRACTICE_ID, batchSize: 10 });

    // First pass: the seed already carries the imported rows (seed v3) and
    // the demo artifacts agree with them byte-for-byte — all unchanged.
    const first = await runReplyImportBackfill(
      new FakeWorkflowStep(),
      backfillDeps(bucket, scoped),
      scoped,
    );
    expect(first).toMatchObject({
      scanned: googleCount,
      withReply: repliedFixtures.length,
      imported: 0,
      updated: 0,
      unchanged: repliedFixtures.length,
      artifactsMissing: 0,
      artifactsFailed: 0,
    });

    // Simulate a pre-#214 database: drop the imported rows, re-run — the
    // backfill restores them from the artifacts alone.
    await t.db
      .delete(responses)
      .where(eq(responses.practiceId, DEMO_PRACTICE_ID));
    const second = await runReplyImportBackfill(
      new FakeWorkflowStep(),
      backfillDeps(bucket, scoped),
      scoped,
    );
    expect(second).toMatchObject({
      imported: repliedFixtures.length,
      unchanged: 0,
    });
    const counts = await countReviewInboxStatuses(t.db, {
      practiceId: DEMO_PRACTICE_ID,
    });
    expect(counts.responded).toBe(repliedFixtures.length);

    // A reply edited on Google since the seed run: overwrite one demo
    // artifact in place (the seed's keys are stable, not content-addressed)
    // and re-run — the imported row tracks the source.
    const g16 = demoGoogleArtifacts(DEMO_PRACTICE_ID).find((a) =>
      a.key.endsWith("/g16.json"),
    );
    if (!g16) throw new Error("g16 demo artifact missing");
    const page = g16.artifact.page as {
      reviews: Array<{ reviewReply?: Record<string, unknown> }>;
    };
    page.reviews[0]!.reviewReply = {
      comment: "Edited on Google: thanks again for the lovely review!",
      updateTime: "2026-07-09T12:00:00.000Z",
      reviewReplyState: "APPROVED",
    };
    await bucket.put(g16.key, encoder.encode(JSON.stringify(g16.artifact)));

    const third = await runReplyImportBackfill(
      new FakeWorkflowStep(),
      backfillDeps(bucket, scoped),
      scoped,
    );
    expect(third).toMatchObject({
      updated: 1,
      unchanged: repliedFixtures.length - 1,
      imported: 0,
    });
    const [updatedRow] = (await importedResponses(DEMO_PRACTICE_ID)).filter(
      (r) => r.body.startsWith("Edited on Google"),
    );
    expect(updatedRow).toMatchObject({
      status: "published",
      publishUpdateTime: "2026-07-09T12:00:00.000Z",
    });
  });
});
