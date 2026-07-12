/**
 * AI kill switch + budget cap, end-to-end (issue #75): the WIRED classify
 * handler (real dispatcher, real Postgres-backed store, real
 * `practiceAiStatus` gate resolution) with `AI_DISABLED` set — the signal
 * lands unclassified with the re-drive marker, the deterministic keyword
 * fallback writes its urgency derivation, the route stage still runs
 * (recovery opens off the fallback; no DLQ), and after re-enabling, the
 * re-drive pass classifies for real and clears the marker. The budget
 * path exercises the same deferral off seeded `ai_calls` spend against a
 * `practice_settings.ai` cap.
 */

import { FakeAiProvider, JUDGMENTS_PROMPT_NAME } from "@wellregarded/ai";
import { resetEnvCache } from "@wellregarded/core";
import {
  listDeferredClassifications,
  schema,
  updatePracticeAiSettings,
} from "@wellregarded/db";
import { InMemoryRawArtifactBucket } from "@wellregarded/sources/testing";
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  importRun,
  practice,
  signal,
} from "../../../packages/db/test/factories.js";
import { setupTestDb } from "../../../packages/db/test/harness.js";
import { handleQueueBatch } from "../src/dispatch";
import { classifySignal, createClassifyStore } from "../src/stages/classify";
import {
  fakeMessage,
  type IntegrationEnv,
  integrationEnv,
} from "./support/integrationEnv";

const t = setupTestDb();
const { signals, derivations, aiCalls, auditLog } = schema;

let env: IntegrationEnv;

beforeEach(() => {
  resetEnvCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  env = integrationEnv(t.databaseName, new InMemoryRawArtifactBucket());
});

// Urgent on keywords ("swelling", "unbearable"), ≥ 3 words so the real
// pass takes the model path, < 15 words so the excerpt pass
// short-circuits to one whole-text excerpt (no second fixture needed).
const URGENT_TEXT = "The swelling is unbearable and nobody will call me back.";

const judgmentsFixture = {
  sentiment: {
    value: "negative",
    confidence: 0.95,
    rationale: "Ongoing pain and no callback.",
  },
  urgency: {
    value: "critical",
    confidence: 0.9,
    rationale: "Acute symptoms happening now.",
  },
  response_risk: {
    value: "high",
    confidence: 0.8,
    rationale: "Clinical details; reply carefully.",
  },
  publication_suitability: {
    value: "unsuitable",
    confidence: 0.9,
    rationale: "Health details the author may regret.",
  },
};

async function seedPendingSignal() {
  const p = await practice(t.db);
  const run = await importRun(t.db, { practiceId: p.id });
  const s = await signal(t.db, {
    practiceId: p.id,
    importRunId: run.id,
    sourceKind: "google",
    sourceId: `kill-switch-${Date.now()}`,
    visibility: "public",
    originalText: URGENT_TEXT,
    originalRating: "1.0",
    pipelineStatus: "pending_classify",
  });
  return { p, run, s };
}

function classifyBody(s: { id: string; practiceId: string }, runId: string) {
  return {
    signalId: s.id,
    practiceId: s.practiceId,
    importRunId: runId,
    requestId: "req-kill-switch",
  };
}

async function derivationRows(signalId: string) {
  return t.db
    .select()
    .from(derivations)
    .where(eq(derivations.signalId, signalId))
    .orderBy(asc(derivations.createdAt));
}

async function signalRow(signalId: string) {
  const rows = await t.db
    .select()
    .from(signals)
    .where(eq(signals.id, signalId));
  const row = rows[0];
  if (!row) throw new Error("signal vanished");
  return row;
}

describe("AI kill switch (AI_DISABLED) through the wired spine", () => {
  it("defers, keyword-routes urgency, routes without DLQ, then re-drives", async () => {
    const { run, s } = await seedPendingSignal();

    // ---- Phase 1: classify with the kill switch on. ----
    const disabledEnv = { ...env, AI_DISABLED: "true" } as IntegrationEnv;
    const classifyMessage = fakeMessage(classifyBody(s, run.id));
    await handleQueueBatch(
      { queue: "wr-classify", messages: [classifyMessage] },
      disabledEnv,
    );

    expect(classifyMessage.ack).toHaveBeenCalledOnce();
    expect(disabledEnv.CLASSIFY_DLQ.sent).toHaveLength(0);

    // Unclassified except the deterministic fallback: exactly ONE
    // derivation, the keyword-fallback urgency row.
    const deferredRows = await derivationRows(s.id);
    expect(deferredRows).toHaveLength(1);
    expect(deferredRows[0]).toMatchObject({
      dimension: "urgency",
      value: "high",
      confidence: 0.3,
      basis: "inferred_text",
      modelVersion: "keyword-fallback-v1",
    });

    // The re-drive marker is set.
    const afterClassify = await signalRow(s.id);
    expect(afterClassify.classificationDeferredAt).not.toBeNull();

    // Route was enqueued; drive it — no DLQ, recovery opens off the
    // fallback urgency, the review still enters the inbox.
    expect(disabledEnv.ROUTE_QUEUE.sent).toHaveLength(1);
    const routeMessage = fakeMessage(disabledEnv.ROUTE_QUEUE.sent[0]);
    await handleQueueBatch(
      { queue: "wr-route", messages: [routeMessage] },
      disabledEnv,
    );
    expect(routeMessage.ack).toHaveBeenCalledOnce();
    expect(disabledEnv.ROUTE_DLQ.sent).toHaveLength(0);

    const audits = await t.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityId, s.id));
    const actions = audits.map((row) => row.action);
    expect(actions).toContain("signal.routed_urgent");
    expect(actions).toContain("signal.entered_review_inbox");
    expect((await signalRow(s.id)).pipelineStatus).toBe("processed");

    // ---- Phase 2: re-enable + re-drive. ----
    // The sweep set: this signal is listed for re-enqueue.
    const deferred = await listDeferredClassifications(t.db, {
      practiceId: s.practiceId,
    });
    expect(deferred.map((row) => row.id)).toContain(s.id);

    // Re-drive the classify pass (the sweep re-enqueues ClassifyMessages;
    // here we drive the stage directly with the fixture provider — the
    // wired handler needs a live Anthropic key).
    const provider = new FakeAiProvider({
      [JUDGMENTS_PROMPT_NAME]: [judgmentsFixture],
    });
    resetEnvCache();
    await classifySignal(classifyBody(s, run.id), env, {
      store: createClassifyStore(t.db),
      provider,
      embedder: undefined,
      pipelineModel: "claude-haiku-4-5-20251001",
      aiGate: async () => ({ allow: true }),
    });

    expect(provider.calls.length).toBeGreaterThan(0);
    const finalRows = await derivationRows(s.id);
    // 1 fallback row + 4 real judgment rows (append-only history).
    expect(finalRows).toHaveLength(5);
    expect(
      finalRows.filter((row) => row.modelVersion === "fake-pipeline"),
    ).toHaveLength(4);

    // Marker cleared: the sweep shrinks.
    expect((await signalRow(s.id)).classificationDeferredAt).toBeNull();
    expect(
      await listDeferredClassifications(t.db, { practiceId: s.practiceId }),
    ).toHaveLength(0);
  });
});

describe("budget cap at 100% through the wired classify handler", () => {
  it("defers with the keyword fallback when the month's spend meets the cap", async () => {
    const { run, s } = await seedPendingSignal();

    // Spend 100¢ this month (1M Haiku input tokens), cap at 100¢.
    await t.db.insert(aiCalls).values({
      practiceId: s.practiceId,
      purpose: "judgments",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 1_000_000,
      outputTokens: 0,
      latencyMs: 400,
    });
    await updatePracticeAiSettings(t.db, {
      practiceId: s.practiceId,
      settings: { monthlyBudgetCents: 100 },
      actor: { type: "system", id: "test" },
    });

    const message = fakeMessage(classifyBody(s, run.id));
    await handleQueueBatch({ queue: "wr-classify", messages: [message] }, env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(env.CLASSIFY_DLQ.sent).toHaveLength(0);

    const rows = await derivationRows(s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dimension: "urgency",
      value: "high",
      modelVersion: "keyword-fallback-v1",
    });
    expect((await signalRow(s.id)).classificationDeferredAt).not.toBeNull();
    // The route hop still flows.
    expect(env.ROUTE_QUEUE.sent).toHaveLength(1);
  });

  it("under the cap, classification proceeds normally (needs no key here: rating-only)", async () => {
    const p = await practice(t.db);
    const run = await importRun(t.db, { practiceId: p.id });
    const s = await signal(t.db, {
      practiceId: p.id,
      importRunId: run.id,
      sourceKind: "google",
      sourceId: `under-cap-${Date.now()}`,
      visibility: "public",
      originalText: null,
      originalRating: "5.0",
      pipelineStatus: "pending_classify",
    });
    await updatePracticeAiSettings(t.db, {
      practiceId: p.id,
      settings: { monthlyBudgetCents: 10_000 },
      actor: { type: "system", id: "test" },
    });

    const message = fakeMessage(classifyBody(s, run.id));
    await handleQueueBatch({ queue: "wr-classify", messages: [message] }, env);

    expect(message.ack).toHaveBeenCalledOnce();
    const rows = await derivationRows(s.id);
    // The deterministic rating-only path ran — not a deferral.
    expect(rows.length).toBeGreaterThan(1);
    expect((await signalRow(s.id)).classificationDeferredAt).toBeNull();
  });
});
