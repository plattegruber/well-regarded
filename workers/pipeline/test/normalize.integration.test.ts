/**
 * Normalize stage end-to-end (issue #104): the real dispatcher + the real
 * wired `normalize` handler against a real Postgres (packages/db's
 * template-clone harness), with fixture artifacts for TWO source kinds in
 * an in-memory R2 bucket.
 *
 * Covers: signals rows created `pending_dedupe` with full provenance,
 * confident hint matches setting FKs vs stored hints, the PII patient seam,
 * `import_runs` counts updated transactionally, dedupe messages enqueued —
 * and idempotent re-delivery routing conflicts to dedupe as potential
 * updates. Failure paths (missing artifact / unknown kind) land on the DLQ
 * path and become visible in the run's error samples.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { resetEnvCache } from "@wellregarded/core";
import {
  countReviewInboxStatuses,
  getImportRunSummary,
  schema,
} from "@wellregarded/db";
import {
  buildCsvImportBatchArtifact,
  buildManualEntryArtifact,
  csvRowSourceId,
  type ManualEntryArtifact,
  putRawArtifact,
} from "@wellregarded/sources";
import { InMemoryRawArtifactBucket } from "@wellregarded/sources/testing";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  importRun,
  location,
  practice,
  provider,
} from "../../../packages/db/test/factories.js";
import { setupTestDb } from "../../../packages/db/test/harness.js";
import { handleQueueBatch } from "../src/dispatch";
import {
  fakeMessage,
  type IntegrationEnv,
  integrationEnv,
} from "./support/integrationEnv";

const t = setupTestDb();
const { signals, patients, contactPoints, consents, auditLog, responses } =
  schema;

let bucket: InMemoryRawArtifactBucket;
let env: IntegrationEnv;

beforeEach(() => {
  resetEnvCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  bucket = new InMemoryRawArtifactBucket();
  env = integrationEnv(t.databaseName, bucket);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A practice with entities matching the manual entry fixtures' hints. */
async function fixturePractice() {
  const p = await practice(t.db);
  const patel = await provider(t.db, {
    practiceId: p.id,
    displayName: "Dr. Patel",
  });
  const mainStreet = await location(t.db, {
    practiceId: p.id,
    name: "Main Street office",
  });
  const run = await importRun(t.db, { practiceId: p.id, sourceKind: "manual" });
  return { p, patel, mainStreet, run };
}

const STAFF_ID = "b3c58c7f-4e3d-4a32-8b78-7e3f0d2f6c12";

/** The full manual-entry envelope (#138): patient + attested consent + hints. */
function manualFullArtifact(practiceId: string): ManualEntryArtifact {
  return buildManualEntryArtifact({
    practiceId,
    sourceId: "c4d69d80-5f4e-4b43-9c89-8f4a1e3a7d23",
    enteredBy: STAFF_ID,
    enteredAt: "2026-03-03T09:30:00Z",
    entry: {
      text:
        "Dr. Patel was wonderful with my daughter — she actually looks " +
        "forward to the dentist now.",
      occurredAt: "2026-03-02T14:30:00Z",
      sourceDescription: "phone call",
      locationName: "Main Street office",
      providerName: "Dr. Patel",
      patient: { name: "Rosa Alvarez", email: "rosa.alvarez@example.com" },
      consent: {
        choice: "practice_attested",
        channels: ["website", "gbp"],
        note: "Said yes over the phone, 3/2, spoke with Dana.",
      },
    },
  });
}

/** The minimal envelope: text only, consent not asked. */
function manualMinimalArtifact(practiceId: string): ManualEntryArtifact {
  return buildManualEntryArtifact({
    practiceId,
    sourceId: "a2f47b6e-3d2c-4f21-9a67-6d2f9c1e5b01",
    enteredBy: STAFF_ID,
    enteredAt: "2026-03-02T15:00:00Z",
    entry: {
      text: "Front desk fit me in the same day for a broken crown.",
      occurredAt: "2026-03-02T00:00:00Z",
      sourceDescription: "in person",
      consent: { choice: "unknown" },
    },
  });
}

async function storeArtifact(
  practiceId: string,
  sourceKind: "manual" | "csv_import" | "google" | "opendental",
  artifact: unknown,
): Promise<string> {
  const { key } = await putRawArtifact(bucket, {
    practiceId,
    sourceKind,
    content: JSON.stringify(artifact),
  });
  return key;
}

async function deliverIngest(body: unknown) {
  const message = fakeMessage(body);
  await handleQueueBatch({ queue: "wr-ingest", messages: [message] }, env);
  return message;
}

describe("normalize end-to-end (manual entry adapter, #138)", () => {
  it("creates one pending_dedupe signal with provenance, resolves manual hints, links the patient, and records the attested consent", async () => {
    const { p, patel, mainStreet, run } = await fixturePractice();
    const artifact = manualFullArtifact(p.id);
    const key = await storeArtifact(p.id, "manual", artifact);

    const message = await deliverIngest({
      importRunId: run.id,
      rawArtifactKey: key,
      sourceKind: "manual",
      practiceId: p.id,
    });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();

    const rows = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, p.id));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      pipelineStatus: "pending_dedupe",
      importRunId: run.id,
      rawArtifactKey: key,
      sourceKind: "manual",
      sourceId: artifact.sourceId,
      visibility: "private",
    });

    // Confident manual hints resolve: exact names → FKs set, hints null.
    expect(row?.providerId).toBe(patel.id);
    expect(row?.locationId).toBe(mainStreet.id);
    expect(row?.providerHint).toBeNull();
    expect(row?.locationHint).toBeNull();
    expect(row?.originalText).toContain("Dr. Patel was wonderful");
    expect(row?.originalRating).toBeNull();

    // The patient hint went through pii.patients/contact_points and linked.
    expect(row?.patientId).not.toBeNull();
    const [patientRow] = await t.db
      .select()
      .from(patients)
      .where(eq(patients.practiceId, p.id));
    expect(patientRow?.id).toBe(row?.patientId);
    expect(patientRow?.displayName).toBe("Rosa Alvarez");
    const points = await t.db
      .select()
      .from(contactPoints)
      .where(eq(contactPoints.patientId, patientRow?.id ?? ""));
    expect(points).toHaveLength(1);
    expect(points[0]?.kind).toBe("email");

    // The attestation became a real consents row in the same transaction
    // (#138 requirement 4), plus its own audit entry with the note.
    const consentRows = await t.db
      .select()
      .from(consents)
      .where(eq(consents.practiceId, p.id));
    expect(consentRows).toHaveLength(1);
    expect(consentRows[0]).toMatchObject({
      signalId: row?.id,
      patientId: row?.patientId,
      source: "practice_attested",
      channels: ["website", "gbp"],
      attribution: "anonymous",
      consentVersion: 1,
      revokedAt: null,
    });
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.practiceId, p.id));
    const consentAudit = audits.find((a) => a.action === "consent.granted");
    expect(consentAudit).toMatchObject({
      actorType: "staff",
      actorId: STAFF_ID,
      entityType: "consents",
      entityId: consentRows[0]?.id,
    });
    expect(consentAudit?.payload).toMatchObject({
      note: "Said yes over the phone, 3/2, spoke with Dana.",
      channels: ["website", "gbp"],
    });

    // Counts committed with the rows; no failures.
    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.run.created).toBe(1);
    expect(summary?.errorCount).toBe(0);

    // One dedupe message, not flagged (new row).
    expect(env.DEDUPE_QUEUE.sent).toHaveLength(1);
    expect(env.DEDUPE_QUEUE.sent[0]).toMatchObject({
      practiceId: p.id,
      importRunId: run.id,
    });
    expect(env.DEDUPE_QUEUE.sent[0]).not.toHaveProperty("reason");
  });

  it('"not asked" consent writes NO consents row — the absence is the state', async () => {
    const { p, run } = await fixturePractice();
    const artifact = manualMinimalArtifact(p.id);
    const key = await storeArtifact(p.id, "manual", artifact);

    const message = await deliverIngest({
      importRunId: run.id,
      rawArtifactKey: key,
      sourceKind: "manual",
      practiceId: p.id,
    });
    expect(message.ack).toHaveBeenCalledOnce();

    const rows = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, p.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.visibility).toBe("private");
    expect(rows[0]?.patientId).toBeNull();

    const consentRows = await t.db
      .select()
      .from(consents)
      .where(eq(consents.practiceId, p.id));
    expect(consentRows).toHaveLength(0);
  });

  it("re-delivery creates no new rows, no duplicate consents, and enqueues potential-update dedupe messages", async () => {
    const { p, run } = await fixturePractice();
    const key = await storeArtifact(p.id, "manual", manualFullArtifact(p.id));
    const body = {
      importRunId: run.id,
      rawArtifactKey: key,
      sourceKind: "manual",
      practiceId: p.id,
    };

    await deliverIngest(body);
    const firstIds = (
      await t.db
        .select({ id: signals.id })
        .from(signals)
        .where(eq(signals.practiceId, p.id))
    )
      .map((row) => row.id)
      .sort();
    expect(firstIds).toHaveLength(1);
    env.DEDUPE_QUEUE.sent.length = 0;

    const second = await deliverIngest(body);
    expect(second.ack).toHaveBeenCalledOnce();

    const afterIds = (
      await t.db
        .select({ id: signals.id })
        .from(signals)
        .where(eq(signals.practiceId, p.id))
    )
      .map((row) => row.id)
      .sort();
    expect(afterIds).toEqual(firstIds);

    // The conflict is NOT re-granted: still exactly one consents row.
    const consentRows = await t.db
      .select()
      .from(consents)
      .where(eq(consents.practiceId, p.id));
    expect(consentRows).toHaveLength(1);

    // The re-delivered signal routes to dedupe as a potential update,
    // carrying the EXISTING row's id.
    expect(env.DEDUPE_QUEUE.sent).toHaveLength(1);
    expect(env.DEDUPE_QUEUE.sent[0]).toMatchObject({
      reason: "conflict_reimport",
    });
    expect(firstIds).toContain(
      (env.DEDUPE_QUEUE.sent[0] as { signalId: string }).signalId,
    );

    // Conflicts are not "created"; they leave a stats trace instead.
    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.run.created).toBe(1);
    expect(summary?.run.stats).toEqual({ normalize_conflicts: 1 });
  });
});

describe("normalize end-to-end (second source kind: csv import adapter, #135)", () => {
  /** One batch envelope exactly as the import Workflow (#135) stores it. */
  const CSV_DRAFT_ID = "3b74b0f7-6d7c-4b7e-9f36-1af6a29f2f3a";
  const csvBatchArtifact = (practiceId: string) =>
    buildCsvImportBatchArtifact({
      practiceId,
      draftId: CSV_DRAFT_ID,
      batchIndex: 0,
      firstRowNumber: 1,
      headers: ["Date", "Review", "Rating", "Patient", "Email", "Doctor"],
      mapping: {
        occurredAt: { column: "Date", dateFormat: "ISO" },
        text: { column: "Review" },
        rating: { column: "Rating", ratingScale: 5 },
        patientName: { column: "Patient" },
        patientEmail: { column: "Email" },
        providerHint: { column: "Doctor" },
        consentHint: { constant: "imported_unknown" },
      },
      rows: [
        [
          "2026-04-01T10:00:00Z",
          "The hygiene team here is the most careful I have experienced.",
          "5",
          "R. Alvarez",
          "r.alvarez@example.com",
          "Dr. Patel",
        ],
        [
          "2026-04-02T15:30:00-05:00",
          "Care was fine; the waiting room gets cramped.",
          "3",
          "",
          "",
          "",
        ],
      ],
    });

  it("resolves by sourceKind, stores unmatched hints with basis, and links patients through the PII seam", async () => {
    // No providers/locations created: the csv hints must stay hints.
    const p = await practice(t.db);
    const run = await importRun(t.db, {
      practiceId: p.id,
      sourceKind: "csv_import",
    });
    const artifact = csvBatchArtifact(p.id);
    const key = await storeArtifact(p.id, "csv_import", artifact);

    const message = await deliverIngest({
      importRunId: run.id,
      rawArtifactKey: key,
      sourceKind: "csv_import",
      practiceId: p.id,
    });
    expect(message.ack).toHaveBeenCalledOnce();

    const rows = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, p.id));
    expect(rows).toHaveLength(artifact.rows.length);
    expect(rows.every((row) => row.sourceKind === "csv_import")).toBe(true);

    // Row 1's identity is the deterministic per-row hash (#135).
    const row1SourceId = await csvRowSourceId(CSV_DRAFT_ID, 1);
    const row1 = rows.find((row) => row.sourceId === row1SourceId);
    expect(row1).toBeDefined();

    // row 1's provider hint has no matching entity: stored, never guessed.
    expect(row1?.providerId).toBeNull();
    expect(row1?.providerHint).toEqual({
      text: "Dr. Patel",
      basis: "source_metadata",
    });

    // The patient hint went through pii.patients/contact_points and linked.
    expect(row1?.patientId).not.toBeNull();
    const [patient] = await t.db
      .select()
      .from(patients)
      .where(eq(patients.practiceId, p.id));
    expect(patient?.id).toBe(row1?.patientId);
    expect(patient?.displayName).toBe("R. Alvarez");
    const points = await t.db
      .select()
      .from(contactPoints)
      .where(eq(contactPoints.patientId, patient?.id ?? ""));
    expect(points).toHaveLength(1);
    expect(points[0]?.kind).toBe("email");

    // Re-delivery matches the same patient by contact point (no duplicate).
    env.DEDUPE_QUEUE.sent.length = 0;
    await deliverIngest({
      importRunId: run.id,
      rawArtifactKey: key,
      sourceKind: "csv_import",
      practiceId: p.id,
    });
    const allPatients = await t.db
      .select()
      .from(patients)
      .where(eq(patients.practiceId, p.id));
    expect(allPatients).toHaveLength(1);

    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.run.created).toBe(artifact.rows.length);
  });
});

describe("normalize end-to-end (google reviews adapter, #125)", () => {
  /** The recorded reviews page shared with the fake GBP server (#130). */
  async function loadRecordedPage(): Promise<{ reviews: unknown[] }> {
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

  it("a poller envelope lands one public signal row per review with google provenance", async () => {
    const p = await practice(t.db);
    const run = await importRun(t.db, {
      practiceId: p.id,
      sourceKind: "google",
    });
    const page = await loadRecordedPage();
    // The artifact exactly as the poller (#123) stores it: the raw page
    // wrapped in the envelope from packages/sources/src/google/schema.ts.
    const key = await storeArtifact(p.id, "google", {
      kind: "gbp.reviews.page",
      envelopeVersion: 1,
      practiceId: p.id,
      googleLocationName: "accounts/1/locations/1",
      fetchedAt: "2026-07-01T00:00:00.000Z",
      page,
    });

    const message = await deliverIngest({
      importRunId: run.id,
      rawArtifactKey: key,
      sourceKind: "google",
      practiceId: p.id,
    });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();

    const rows = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, p.id))
      .orderBy(signals.sourceId);
    expect(rows).toHaveLength(page.reviews.length);
    for (const row of rows) {
      expect(row.sourceKind).toBe("google");
      expect(row.visibility).toBe("public");
      expect(row.pipelineStatus).toBe("pending_dedupe");
      expect(row.rawArtifactKey).toBe(key);
      expect(row.sourceId).toMatch(/^accounts\/1\/locations\/1\/reviews\/\d+$/);
      expect(row.patientId).toBeNull();
      // No location named "accounts/1/locations/1" exists, so the mapping
      // hint is STORED (text + basis), never a guessed FK — the #121
      // mapping lookup resolves it once that lands.
      expect(row.locationId).toBeNull();
      expect(row.locationHint).toEqual({
        text: "accounts/1/locations/1",
        basis: "source_metadata",
      });
    }

    // Star-only review: a rating-only row, not dropped, not empty-stringed.
    const starOnly = rows.find((row) => row.sourceId?.endsWith("/reviews/14"));
    expect(starOnly?.originalText).toBeNull();
    expect(starOnly?.originalRating).toBe("4.0");

    // Edited review: occurred_at is the experience time (createTime), even
    // though the fetched payload carries a later updateTime.
    const edited = rows.find((row) => row.sourceId?.endsWith("/reviews/2"));
    expect(edited?.occurredAt.toISOString()).toBe("2025-07-25T15:13:43.000Z");

    // Replied review: original content lands untouched; the existing-reply
    // state rides the wire metadata (no signals column), never a responses
    // row — Epic #10 imports that state.
    const replied = rows.find((row) => row.sourceId?.endsWith("/reviews/4"));
    expect(replied?.originalRating).toBe("2.0");

    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.run.created).toBe(page.reviews.length);
    expect(summary?.errorCount).toBe(0);
    expect(env.DEDUPE_QUEUE.sent).toHaveLength(page.reviews.length);
  });

  it("a malformed page (unknown starRating) fails the artifact loudly onto the run", async () => {
    const p = await practice(t.db);
    const run = await importRun(t.db, {
      practiceId: p.id,
      sourceKind: "google",
    });
    const key = await storeArtifact(p.id, "google", {
      kind: "gbp.reviews.page",
      envelopeVersion: 1,
      practiceId: p.id,
      googleLocationName: "accounts/1/locations/1",
      fetchedAt: "2026-07-01T00:00:00.000Z",
      page: {
        reviews: [
          {
            name: "accounts/1/locations/1/reviews/1",
            reviewId: "1",
            reviewer: { displayName: "Maria Delgado" },
            starRating: "STAR_RATING_UNSPECIFIED",
            createTime: "2026-05-01T09:00:00.000Z",
            updateTime: "2026-05-01T09:00:00.000Z",
          },
        ],
      },
    });

    const message = await deliverIngest({
      importRunId: run.id,
      rawArtifactKey: key,
      sourceKind: "google",
      practiceId: p.id,
    });
    // Non-retryable: the same bytes will never parse — DLQ, not retry.
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(env.INGEST_DLQ.sent).toHaveLength(1);

    const dlqMessage = fakeMessage(env.INGEST_DLQ.sent[0]);
    await handleQueueBatch(
      { queue: "wr-ingest-dlq", messages: [dlqMessage] },
      env,
    );

    const rows = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, p.id));
    expect(rows).toHaveLength(0);
    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.errorCount).toBe(1);
    expect(summary?.errorSamples[0]?.message).toContain('adapter "google"');
  });
});

describe("normalize persists pre-existing owner replies as imported responses (#214)", () => {
  /** The recorded page again — it carries four replied reviews. */
  async function loadRecordedPage(): Promise<{
    reviews: Array<{
      name: string;
      reviewReply?: { comment: string; updateTime?: string };
    }>;
  }> {
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

  function envelope(practiceId: string, page: unknown) {
    return {
      kind: "gbp.reviews.page",
      envelopeVersion: 1,
      practiceId,
      googleLocationName: "accounts/1/locations/1",
      fetchedAt: "2026-07-01T00:00:00.000Z",
      page,
    };
  }

  async function fixtureRun() {
    const p = await practice(t.db);
    const run = await importRun(t.db, {
      practiceId: p.id,
      sourceKind: "google",
    });
    const page = await loadRecordedPage();
    return { p, run, page };
  }

  async function deliver(practiceId: string, runId: string, page: unknown) {
    const key = await storeArtifact(
      practiceId,
      "google",
      envelope(practiceId, page),
    );
    const message = await deliverIngest({
      importRunId: runId,
      rawArtifactKey: key,
      sourceKind: "google",
      practiceId,
    });
    expect(message.ack).toHaveBeenCalledOnce();
    return key;
  }

  async function importedResponses(practiceId: string) {
    return t.db
      .select({
        response: responses,
        sourceId: signals.sourceId,
      })
      .from(responses)
      .innerJoin(signals, eq(signals.id, responses.signalId))
      .where(
        and(
          eq(responses.practiceId, practiceId),
          eq(responses.origin, "source_import"),
        ),
      );
  }

  async function importAudits(practiceId: string) {
    const rows = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.practiceId, practiceId));
    return rows.filter((row) => row.action.startsWith("response.import"));
  }

  it("each replied review lands one published source_import response in the artifact's transaction, audited, and the inbox reads responded", async () => {
    const { p, run, page } = await fixtureRun();
    const repliedNames = page.reviews
      .filter((review) => review.reviewReply !== undefined)
      .map((review) => review.name);
    expect(repliedNames.length).toBeGreaterThan(0);

    await deliver(p.id, run.id, page);

    const imported = await importedResponses(p.id);
    expect(new Set(imported.map((row) => row.sourceId))).toEqual(
      new Set(repliedNames),
    );
    for (const row of imported) {
      expect(row.response).toMatchObject({
        origin: "source_import",
        status: "published",
        authorId: null,
      });
    }

    // The REJECTED reply carries its full moderation state (#214 req 1);
    // published_at is Google's reply updateTime.
    const rejected = imported.find((row) =>
      row.sourceId?.endsWith("/reviews/4"),
    );
    expect(rejected?.response).toMatchObject({
      moderationState: "REJECTED",
      policyViolation:
        "Reply removed for policy violation: contains personal health information.",
      publishUpdateTime: "2026-06-12T05:35:36.000Z",
    });
    expect(rejected?.response.publishedAt?.toISOString()).toBe(
      "2026-06-12T05:35:36.000Z",
    );
    expect(rejected?.response.body).toContain(
      "We apologize for the billing confusion.",
    );

    // Audited as the pipeline's system actor (#214 req 4).
    const audits = await importAudits(p.id);
    expect(audits).toHaveLength(repliedNames.length);
    for (const entry of audits) {
      expect(entry).toMatchObject({
        action: "response.imported",
        actorType: "system",
        actorId: "pipeline:normalize",
      });
      expect(entry.payload).toMatchObject({ importRunId: run.id });
    }

    // Inbox integration (#214 req 3): the imported replies count as
    // responded through the existing latest-response join — no new SQL.
    const counts = await countReviewInboxStatuses(t.db, { practiceId: p.id });
    expect(counts.responded).toBe(repliedNames.length);
    expect(counts.needs_response).toBe(
      page.reviews.length - repliedNames.length,
    );
  });

  it("a re-poll is idempotent: no duplicate imported rows, no duplicate audits", async () => {
    const { p, run, page } = await fixtureRun();
    await deliver(p.id, run.id, page);
    const before = await importedResponses(p.id);

    await deliver(p.id, run.id, page);

    const after = await importedResponses(p.id);
    expect(after.map((row) => row.response.id).sort()).toEqual(
      before.map((row) => row.response.id).sort(),
    );
    // Byte-identical replies re-poll silently: still only the original
    // `response.imported` entries, nothing marked updated.
    const audits = await importAudits(p.id);
    expect(audits.map((a) => a.action)).toEqual(
      before.map(() => "response.imported"),
    );
  });

  it("a reply edited on Google updates the imported row in place on the next poll", async () => {
    const { p, run, page } = await fixtureRun();
    await deliver(p.id, run.id, page);
    const before = await importedResponses(p.id);
    const target = before.find((row) => row.sourceId?.endsWith("/reviews/4"));
    expect(target).toBeDefined();

    // The owner rewrote the rejected reply; Google re-moderates it.
    const edited = structuredClone(page);
    const editedReview = edited.reviews.find((review) =>
      review.name.endsWith("/reviews/4"),
    ) as { reviewReply?: Record<string, unknown> };
    editedReview.reviewReply = {
      comment: "We are sorry about the billing mix-up — please call us.",
      updateTime: "2026-07-02T09:00:00.000Z",
      reviewReplyState: "PENDING",
    };
    await deliver(p.id, run.id, edited);

    const after = await importedResponses(p.id);
    expect(after).toHaveLength(before.length);
    const updated = after.find((row) => row.sourceId?.endsWith("/reviews/4"));
    // Same row, tracked content — never a second imported row.
    expect(updated?.response.id).toBe(target?.response.id);
    expect(updated?.response).toMatchObject({
      body: "We are sorry about the billing mix-up — please call us.",
      moderationState: "PENDING",
      policyViolation: null,
      publishUpdateTime: "2026-07-02T09:00:00.000Z",
    });

    const audits = await importAudits(p.id);
    expect(
      audits.filter((a) => a.action === "response.import_updated"),
    ).toHaveLength(1);
  });
});

describe("normalize failure paths land in the import run (issues #104/#111)", () => {
  it("missing artifact: DLQ forward, then the DLQ consumer records it on the run", async () => {
    const { p, run } = await fixturePractice();
    const body = {
      importRunId: run.id,
      rawArtifactKey: `${p.id}/manual/never-stored.json`,
      sourceKind: "manual",
      practiceId: p.id,
    };

    const message = await deliverIngest(body);
    // Store-before-enqueue violation: forwarded (not retried), then acked.
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(env.INGEST_DLQ.sent).toHaveLength(1);

    // The platform then delivers that envelope on the DLQ; consume it.
    const dlqMessage = fakeMessage(env.INGEST_DLQ.sent[0]);
    await handleQueueBatch(
      { queue: "wr-ingest-dlq", messages: [dlqMessage] },
      env,
    );
    expect(dlqMessage.ack).toHaveBeenCalledOnce();

    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.errorCount).toBe(1);
    expect(summary?.errorSamples[0]).toMatchObject({
      stage: "ingest",
      payloadRef: body.rawArtifactKey,
    });
    expect(summary?.errorSamples[0]?.message).toContain(
      "Raw artifact not found",
    );
    expect(summary?.run.created).toBe(0);
  });

  it("unknown sourceKind: DLQ forward with the failure recorded on the run", async () => {
    const p = await practice(t.db);
    const run = await importRun(t.db, {
      practiceId: p.id,
      sourceKind: "opendental",
    });
    const key = await storeArtifact(p.id, "opendental", { events: [] });
    const body = {
      importRunId: run.id,
      rawArtifactKey: key,
      sourceKind: "opendental",
      practiceId: p.id,
    };

    const message = await deliverIngest(body);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(env.INGEST_DLQ.sent).toHaveLength(1);

    const dlqMessage = fakeMessage(env.INGEST_DLQ.sent[0]);
    await handleQueueBatch(
      { queue: "wr-ingest-dlq", messages: [dlqMessage] },
      env,
    );

    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.errorCount).toBe(1);
    expect(summary?.errorSamples[0]?.message).toContain(
      'no SourceAdapter registered for sourceKind "opendental"',
    );
  });
});
