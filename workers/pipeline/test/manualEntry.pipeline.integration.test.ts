/**
 * Manual entry, end-to-end through the WHOLE pipeline spine (issue #138):
 * one stored manual-entry envelope pumped through ingest → dedupe →
 * classify → route with the real dispatcher, the real Postgres-backed
 * stores, the deterministic fake embedder, and the fixture-driven fake
 * classifier — proving the issue's structural rule: a typed-in signal gets
 * the exact same derivations, consent handling, and routing an imported
 * one does, because it IS an import (a one-row `manual` run).
 */

import {
  FakeAiProvider,
  FakeEmbeddingProvider,
  JUDGMENTS_PROMPT_NAME,
} from "@wellregarded/ai";
import { resetEnvCache } from "@wellregarded/core";
import { getImportRunSummary, schema } from "@wellregarded/db";
import {
  buildManualEntryArtifact,
  type ManualEntryArtifact,
  putRawArtifact,
} from "@wellregarded/sources";
import { InMemoryRawArtifactBucket } from "@wellregarded/sources/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  importRun,
  location,
  practice,
  provider,
} from "../../../packages/db/test/factories.js";
import { setupTestDb } from "../../../packages/db/test/harness.js";
import { handleQueueBatch, type StageHandlers } from "../src/dispatch";
import { stageHandlers } from "../src/stages";
import { classifySignal, createClassifyStore } from "../src/stages/classify";
import { createDedupeStore, dedupeSignal } from "../src/stages/dedupe";
import {
  fakeMessage,
  type IntegrationEnv,
  integrationEnv,
} from "./support/integrationEnv";

const t = setupTestDb();
const { signals, consents, derivations, auditLog } = schema;

const STAFF_ID = "b3c58c7f-4e3d-4a32-8b78-7e3f0d2f6c12";
const SOURCE_ID = "c4d69d80-5f4e-4b43-9c89-8f4a1e3a7d23";

// Under 15 words on purpose: classify then stores the whole text as the
// single excerpt without a second model call (issue #69's short-text path)
// — one judgments fixture drives the full chain deterministically.
const ENTRY_TEXT = "Dr. Patel was wonderful with my daughter at the visit.";

const judgmentsFixture = {
  sentiment: {
    value: "positive",
    confidence: 0.95,
    rationale: "Grateful praise for the provider.",
  },
  urgency: {
    value: "none",
    confidence: 0.9,
    rationale: "Nothing needs a response right now.",
  },
  response_risk: {
    value: "low",
    confidence: 0.9,
    rationale: "A thank-you carries no reply risk.",
  },
  publication_suitability: {
    value: "suitable",
    confidence: 0.85,
    rationale: "Specific, positive, no health details.",
  },
};

let bucket: InMemoryRawArtifactBucket;
let env: IntegrationEnv;
let handlers: StageHandlers;

beforeEach(() => {
  resetEnvCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  bucket = new InMemoryRawArtifactBucket();
  env = integrationEnv(t.databaseName, bucket);
  // Real normalize + route (wired off env.HYPERDRIVE); dedupe and classify
  // over their REAL stores on the harness db with deterministic fakes for
  // the model seams — the production wiring minus live AI.
  handlers = {
    ...stageHandlers,
    dedupe: (message, env) =>
      dedupeSignal(message, env, {
        store: createDedupeStore(t.db),
        embedder: new FakeEmbeddingProvider(),
      }),
    classify: (message, env) =>
      classifySignal(message, env, {
        store: createClassifyStore(t.db),
        provider: new FakeAiProvider({
          [JUDGMENTS_PROMPT_NAME]: [judgmentsFixture],
        }),
        embedder: new FakeEmbeddingProvider(),
        pipelineModel: "claude-haiku-4-5-20251001",
      }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function deliver(queue: string, body: unknown) {
  const message = fakeMessage(body);
  await handleQueueBatch({ queue, messages: [message] }, env, handlers);
  return message;
}

/** Pump every queued message through its stage until the spine drains. */
async function drainPipeline() {
  const lanes = [
    { queue: "wr-dedupe", producer: env.DEDUPE_QUEUE },
    { queue: "wr-classify", producer: env.CLASSIFY_QUEUE },
    { queue: "wr-route", producer: env.ROUTE_QUEUE },
  ];
  let moved = true;
  while (moved) {
    moved = false;
    for (const lane of lanes) {
      const bodies = lane.producer.sent.splice(0);
      for (const body of bodies) {
        moved = true;
        const message = await deliver(lane.queue, body);
        expect(message.ack).toHaveBeenCalledOnce();
      }
    }
  }
}

function attestedArtifact(practiceId: string): ManualEntryArtifact {
  return buildManualEntryArtifact({
    practiceId,
    sourceId: SOURCE_ID,
    enteredBy: STAFF_ID,
    enteredAt: "2026-03-03T09:30:00Z",
    entry: {
      text: ENTRY_TEXT,
      occurredAt: "2026-03-02T14:30:00Z",
      sourceDescription: "phone call",
      locationName: "Main Street office",
      providerName: "Dr. Patel",
      patient: { name: "Rosa Alvarez", email: "rosa.alvarez@example.com" },
      consent: {
        choice: "practice_attested",
        channels: ["website"],
        note: "Said yes over the phone, 3/2, spoke with Dana.",
      },
    },
  });
}

describe("manual entry through the full pipeline (issue #138)", () => {
  it("ingest → dedupe → classify → route: hints resolved, derivations present, consents row, honest counts", async () => {
    const p = await practice(t.db);
    const patel = await provider(t.db, {
      practiceId: p.id,
      displayName: "Dr. Patel",
    });
    const mainStreet = await location(t.db, {
      practiceId: p.id,
      name: "Main Street office",
    });
    const artifact = attestedArtifact(p.id);
    // Store-before-enqueue, exactly as POST /api/signals/manual does.
    const { key } = await putRawArtifact(bucket, {
      practiceId: p.id,
      sourceKind: "manual",
      content: JSON.stringify(artifact),
    });
    const run = await importRun(t.db, {
      practiceId: p.id,
      sourceKind: "manual",
      rawArtifactKeys: [key],
    });

    const ingest = await deliver("wr-ingest", {
      importRunId: run.id,
      rawArtifactKey: key,
      sourceKind: "manual",
      practiceId: p.id,
    });
    expect(ingest.ack).toHaveBeenCalledOnce();
    await drainPipeline();

    // The signal came out the far end: processed, hints resolved to FKs
    // (the form's structured choices round-tripped through name hints).
    const [row] = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, p.id));
    expect(row).toMatchObject({
      sourceKind: "manual",
      sourceId: SOURCE_ID,
      visibility: "private",
      pipelineStatus: "processed",
      providerId: patel.id,
      locationId: mainStreet.id,
      importRunId: run.id,
    });
    expect(row?.patientId).not.toBeNull();

    // Derivations from the (fake) classifier — the whole point of the
    // pipeline round-trip: a typed-in compliment gets classified like any
    // imported review.
    const derivationRows = await t.db
      .select()
      .from(derivations)
      .where(eq(derivations.signalId, row?.id ?? ""));
    expect(derivationRows.map((d) => d.dimension).sort()).toEqual([
      "publication_suitability",
      "response_risk",
      "sentiment",
      "urgency",
    ]);
    expect(derivationRows.every((d) => d.basis === "inferred_text")).toBe(true);

    // The attestation became a consents row with the form's channels.
    const consentRows = await t.db
      .select()
      .from(consents)
      .where(eq(consents.signalId, row?.id ?? ""));
    expect(consentRows).toHaveLength(1);
    expect(consentRows[0]).toMatchObject({
      source: "practice_attested",
      channels: ["website"],
      patientId: row?.patientId,
    });

    // ...with its own audit entry, actor = the attesting staff member.
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.practiceId, p.id));
    expect(
      audits.some(
        (a) =>
          a.action === "consent.granted" &&
          a.actorType === "staff" &&
          a.actorId === STAFF_ID,
      ),
    ).toBe(true);

    // Honest run accounting: one row created, nothing failed — the report
    // page (#137) reads exactly this.
    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.run.created).toBe(1);
    expect(summary?.run.failed).toBe(0);
    expect(summary?.totalProcessed).toBe(1);
  });
});
