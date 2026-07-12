/**
 * CSV import Workflow end-to-end (issue #135): a fixture CSV in an
 * in-memory R2 bucket + a confirmed draft in real Postgres, driven by the
 * real orchestration (`runCsvImport`) with the real dependencies
 * (`createCsvImportDeps`) under the checkpoint-memoizing fake step — and
 * the enqueued batches consumed by the REAL pipeline stages
 * (`workers/pipeline`'s dispatcher: normalize, and dedupe with the fake
 * embedder), so signals rows land through the same code path production
 * uses and the drain loop observes real `import_runs` counts.
 *
 * Run locally with:
 *
 *   docker compose up -d && pnpm --filter @wellregarded/jobs test:integration
 */

import { FakeEmbeddingProvider } from "@wellregarded/ai";
import { resetEnvCache } from "@wellregarded/core";
import { getImportDraft, getImportRunSummary, schema } from "@wellregarded/db";
import { putRawImportArtifact } from "@wellregarded/sources";
import { InMemoryRawArtifactBucket } from "@wellregarded/sources/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  importDraft,
  practice,
  provider,
  staffMember,
} from "../../../packages/db/test/factories.js";
import { setupTestDb } from "../../../packages/db/test/harness.js";
import {
  handleQueueBatch,
  type StageHandlers,
} from "../../pipeline/src/dispatch";
import { stageHandlers } from "../../pipeline/src/stages";
import {
  createDedupeStore,
  dedupeSignal,
} from "../../pipeline/src/stages/dedupe";
import {
  fakeMessage,
  type IntegrationEnv,
  integrationEnv,
} from "../../pipeline/test/support/integrationEnv";
import {
  type CsvImportParams,
  createCsvImportDeps,
  runCsvImport,
} from "../src/csvImport";
import { FakeWorkflowStep } from "./support/fakeStep";

const t = setupTestDb();
const { signals, auditLog, consents, patients } = schema;

const HEADERS = "Date,Rating,Review,Patient Name,Patient Email,Doctor";

const MAPPING = {
  occurredAt: { column: "Date", dateFormat: "MM/DD/YYYY" as const },
  rating: { column: "Rating", ratingScale: 5 as const },
  text: { column: "Review" },
  patientName: { column: "Patient Name" },
  patientEmail: { column: "Patient Email" },
  providerHint: { column: "Doctor" },
  visibility: { constant: "private" as const },
  consentHint: { constant: "imported_unknown" as const },
};

/**
 * A generated export: `rows` data rows behind a BOM'd CRLF header. Rows
 * 10 and 20 are invalid (unparseable / impossible date); only the first
 * three rows carry PII (keeps the PII-seam exercise without 350
 * encryptions). Texts vary per row so fuzzy dedupe has no reason to fire.
 */
function fixtureCsv(rows: number): string {
  const templates = [
    "Cleaning number %N was quick and painless.",
    "Billing question %N got sorted right away.",
    "Waited a while on visit %N but the care was thorough.",
    "Front desk handled appointment %N kindly.",
    'Visit %N: "great with kids", would return.',
  ];
  const lines = [`\uFEFF${HEADERS}`];
  for (let n = 1; n <= rows; n++) {
    if (n === 10) {
      lines.push("not-a-date,5,Broken row ten,,,");
      continue;
    }
    if (n === 20) {
      lines.push("04/31/2026,5,Impossible date twenty,,,"); // April has 30 days
      continue;
    }
    const month = String((n % 12) + 1).padStart(2, "0");
    const day = String((n % 27) + 1).padStart(2, "0");
    const text = (templates[n % templates.length] as string)
      .replace("%N", String(n))
      .replace(/"/g, '""'); // RFC 4180 quote escaping inside a quoted field
    const pii = n <= 3 ? `Patient ${n},patient${n}@example.com` : ",";
    lines.push(
      `${month}/${day}/2026,${(n % 5) + 1},"${text}",${pii},Dr. Patel`,
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

let uploads: InMemoryRawArtifactBucket;
let artifacts: InMemoryRawArtifactBucket;
let env: IntegrationEnv;
let handlers: StageHandlers;

beforeEach(() => {
  resetEnvCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  uploads = new InMemoryRawArtifactBucket();
  artifacts = new InMemoryRawArtifactBucket();
  env = integrationEnv(t.databaseName, artifacts);
  // Real normalize (wired off env.HYPERDRIVE); dedupe over the real store
  // with the deterministic fake embedder (same wiring as the pipeline's
  // own integration suite).
  handlers = {
    ...stageHandlers,
    dedupe: (message, stageEnv) =>
      dedupeSignal(message, stageEnv, {
        store: createDedupeStore(t.db),
        embedder: new FakeEmbeddingProvider(),
      }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Deliver one ingest message through the real stages. */
async function pump(body: unknown, { throughDedupe = true } = {}) {
  const message = fakeMessage(body);
  await handleQueueBatch(
    { queue: "wr-ingest", messages: [message] },
    env,
    handlers,
  );
  expect(message.retry).not.toHaveBeenCalled();
  if (!throughDedupe) return;
  for (const dedupeBody of env.DEDUPE_QUEUE.sent.splice(0)) {
    await handleQueueBatch(
      { queue: "wr-dedupe", messages: [fakeMessage(dedupeBody)] },
      env,
      handlers,
    );
  }
}

/** A confirmed draft over `csv` uploaded to the in-memory imports bucket. */
async function confirmedDraft(practiceId: string, csv: string) {
  const staff = await staffMember(t.db, { practiceId });
  const bytes = new TextEncoder().encode(csv);
  const { key } = await putRawImportArtifact(uploads, { practiceId, bytes });
  return importDraft(t.db, {
    practiceId,
    createdBy: staff.id,
    r2Key: key,
    byteSize: bytes.byteLength,
    headers: HEADERS.split(","),
    mapping: MAPPING,
    status: "confirmed",
  });
}

function resources(opts: {
  throughDedupe?: boolean;
  send?: (body: unknown) => Promise<void>;
}) {
  const sent: unknown[] = [];
  return {
    sent,
    deps: createCsvImportDeps({
      withDb: (fn) => fn(t.db),
      rawImports: uploads,
      rawArtifacts: artifacts,
      ingest: {
        send: async (body: unknown) => {
          if (opts.send) await opts.send(body);
          sent.push(body);
          await pump(body, { throughDedupe: opts.throughDedupe ?? true });
        },
      },
    }),
  };
}

describe("csv import workflow — full run (350-row fixture)", () => {
  it("produces 4 batch artifacts and 4 ingest messages, lands signals through the real pipeline, and finalizes the report", async () => {
    const p = await practice(t.db);
    await provider(t.db, { practiceId: p.id, displayName: "Dr. Patel" });
    const draft = await confirmedDraft(p.id, fixtureCsv(350));
    // 350 rows through dedupe's fuzzy path would be quadratic noise; the
    // dedupe/route stages get their own focused run below.
    const { sent, deps } = resources({ throughDedupe: false });
    const params: CsvImportParams = {
      importDraftId: draft.id,
      practiceId: p.id,
      requestId: "req-integration-350",
    };

    const summary = await runCsvImport(new FakeWorkflowStep(), deps, params);

    // 350 rows / 100 per batch = 4 artifacts = 4 messages (issue #135).
    expect(summary).toMatchObject({
      batches: 4,
      totalRows: 350,
      failed: 2,
      created: 348,
      merged: 0,
      skipped: 0,
      drained: true,
      status: "completed_with_errors",
    });
    expect(sent).toHaveLength(4);
    expect(artifacts.writeCount).toBe(4);
    for (const body of sent) {
      expect(body).toMatchObject({
        importRunId: summary.importRunId,
        sourceKind: "csv_import",
        practiceId: p.id,
        requestId: "req-integration-350",
      });
    }

    // Signals landed with csv provenance; batch keys recorded on the run.
    const rows = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, p.id));
    expect(rows).toHaveLength(348);
    const run = await getImportRunSummary(t.db, p.id, summary.importRunId);
    expect(run?.run.status).toBe("completed_with_errors");
    expect(run?.totalProcessed).toBe(350);
    expect(run?.run.rawArtifactKeys).toHaveLength(4);
    expect(rows.every((row) => row.sourceKind === "csv_import")).toBe(true);
    expect(
      rows.every((row) =>
        run?.run.rawArtifactKeys.includes(row.rawArtifactKey ?? ""),
      ),
    ).toBe(true);

    // Row-level errors are in the run's samples, with 1-based row refs.
    expect(run?.errorCount).toBe(2);
    expect(run?.errorSamples.map((s) => s.payloadRef)).toEqual([
      "row:10",
      "row:20",
    ]);
    expect(run?.errorSamples[0]?.message).toContain("Row 10:");
    expect(run?.errorSamples[0]?.message).toContain("'not-a-date'");

    // The provider hint resolved against the practice's entities; the
    // PII rows went through the pii.* seam.
    expect(rows.every((row) => row.providerId !== null)).toBe(true);
    expect(rows.filter((row) => row.patientId !== null)).toHaveLength(3);
    expect(
      await t.db.select().from(patients).where(eq(patients.practiceId, p.id)),
    ).toHaveLength(3);

    // Consent rule (Epic #8): imported_unknown rows are analyzable but
    // carry NO publishable consent state — no consents rows exist.
    expect(
      await t.db.select().from(consents).where(eq(consents.practiceId, p.id)),
    ).toHaveLength(0);

    // Draft ↔ run linkage + superseded/completed semantics.
    const finishedDraft = await getImportDraft(t.db, p.id, draft.id);
    expect(finishedDraft?.status).toBe("superseded");
    expect(finishedDraft?.importRunId).toBe(summary.importRunId);

    // Audit trail: started + completed, both by the system actor.
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.practiceId, p.id));
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("import.started");
    expect(actions).toContain("import.completed");
    const completed = audits.find((a) => a.action === "import.completed");
    expect(completed?.actorType).toBe("system");
    expect(completed?.actorId).toBe("jobs:csv-import");
  });
});

describe("csv import workflow — through dedupe", () => {
  it("a small batch flows normalize → dedupe, advancing survivors to pending_classify", async () => {
    const p = await practice(t.db);
    const draft = await confirmedDraft(p.id, fixtureCsv(5));
    const { deps, sent } = resources({ throughDedupe: true });

    const summary = await runCsvImport(new FakeWorkflowStep(), deps, {
      importDraftId: draft.id,
      practiceId: p.id,
    });

    expect(summary).toMatchObject({
      batches: 1,
      totalRows: 5,
      created: 5,
      failed: 0,
      status: "completed",
      drained: true,
    });
    expect(sent).toHaveLength(1);

    const rows = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, p.id));
    expect(rows).toHaveLength(5);
    // Dedupe advanced every survivor; classify messages were enqueued.
    expect(rows.every((row) => row.pipelineStatus === "pending_classify")).toBe(
      true,
    );
    expect(env.CLASSIFY_QUEUE.sent).toHaveLength(5);
    // Visibility came from the mapping's bulk constant.
    expect(rows.every((row) => row.visibility === "private")).toBe(true);
  });

  it("re-delivering a batch is idempotent: conflicts route to dedupe and land as skipped, not new rows", async () => {
    const p = await practice(t.db);
    const draft = await confirmedDraft(p.id, fixtureCsv(4));
    const { deps, sent } = resources({ throughDedupe: true });

    const summary = await runCsvImport(new FakeWorkflowStep(), deps, {
      importDraftId: draft.id,
      practiceId: p.id,
    });

    // Simulate a queue re-delivery of the same batch after the run.
    await pump(sent[0], { throughDedupe: true });

    const rows = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, p.id));
    expect(rows).toHaveLength(4); // deterministic sourceIds: no duplicates
    const run = await getImportRunSummary(t.db, p.id, summary.importRunId);
    // The unchanged re-import lands in `skipped` — counts move past
    // totalRows, which is exactly why the drain condition is `>=`.
    expect(run?.run.skipped).toBe(4);
    expect(run?.totalProcessed).toBe(8);
  });
});

describe("csv import workflow — resume across failures", () => {
  it("a re-invoked instance re-parses nothing and duplicates nothing", async () => {
    const p = await practice(t.db);
    const draft = await confirmedDraft(p.id, fixtureCsv(120));
    let fail = true;
    const { deps, sent } = resources({
      throughDedupe: false,
      send: async () => {
        if (fail) {
          fail = false;
          throw new Error("queue hiccup");
        }
      },
    });
    const step = new FakeWorkflowStep();
    const params: CsvImportParams = {
      importDraftId: draft.id,
      practiceId: p.id,
    };

    // First attempt dies in enqueue-batches (validate/chunk/record are
    // checkpointed); the last-resort step finalizes the run.
    await expect(runCsvImport(step, deps, params)).rejects.toThrow(
      "queue hiccup",
    );
    const draftAfterFailure = await getImportDraft(t.db, p.id, draft.id);
    expect(draftAfterFailure?.status).toBe("confirmed"); // retryable
    const runId = draftAfterFailure?.importRunId as string;
    expect((await getImportRunSummary(t.db, p.id, runId))?.run.status).toBe(
      "failed",
    );
    const artifactsAfterFirstAttempt = artifacts.writeCount;

    // Replay against the same durable state: validate and chunk come from
    // checkpoints — ONE run row, no re-parse, no duplicate artifacts.
    const summary = await runCsvImport(step, deps, params);

    expect(summary.importRunId).toBe(runId);
    expect(summary).toMatchObject({
      batches: 2,
      totalRows: 120,
      created: 118, // rows 10 and 20 are the fixture's invalid rows
      failed: 3, // 2 row errors + the recorded workflow failure
      status: "completed_with_errors",
      drained: true,
    });
    expect(artifacts.writeCount).toBe(artifactsAfterFirstAttempt);
    expect(sent).toHaveLength(2);
    expect(
      await t.db.select().from(signals).where(eq(signals.practiceId, p.id)),
    ).toHaveLength(118);
    // The retried run healed the terminal status and retired the draft.
    expect((await getImportDraft(t.db, p.id, draft.id))?.status).toBe(
      "superseded",
    );
  });
});

describe("csv import workflow — validate rejections", () => {
  it("refuses an unconfirmed draft and a mapping that no longer matches the headers", async () => {
    const p = await practice(t.db);
    const editing = await importDraft(t.db, {
      practiceId: p.id,
      status: "draft",
    });
    const { deps } = resources({});

    await expect(
      runCsvImport(new FakeWorkflowStep(), deps, {
        importDraftId: editing.id,
        practiceId: p.id,
      }),
    ).rejects.toThrow('is "draft"');

    const mismatched = await importDraft(t.db, {
      practiceId: p.id,
      status: "confirmed",
      headers: ["Something", "Else"],
      mapping: MAPPING,
    });
    await expect(
      runCsvImport(new FakeWorkflowStep(), deps, {
        importDraftId: mismatched.id,
        practiceId: p.id,
      }),
    ).rejects.toThrow("references columns");

    // Cross-tenant draft ids are a plain not-found.
    const other = await practice(t.db);
    await expect(
      runCsvImport(new FakeWorkflowStep(), deps, {
        importDraftId: editing.id,
        practiceId: other.id,
      }),
    ).rejects.toThrow("not found");
  });
});
