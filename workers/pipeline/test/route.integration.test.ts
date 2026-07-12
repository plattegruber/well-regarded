/**
 * Route stage end-to-end (issue #108): the real dispatcher + the real
 * wired `route` handler (production `RouteStore`, the real proof sink
 * from #96, the interim audit-only recovery sink) against a real Postgres
 * via packages/db's template-clone harness.
 *
 * Covers, per branch: the audit entry (actor `system` / `pipeline:route`,
 * entity `signals`), the terminal `pipeline_status: 'processed'`, and the
 * import run's per-branch stats counter — plus the quiet path, branch
 * independence (all three at once), manual-outranks-inferred derivation
 * resolution, idempotent re-delivery (no duplicate audits or counts), and
 * the missing-derivations DLQ path landing in the run's error samples.
 */

import { resetEnvCache } from "@wellregarded/core";
import { getImportRunSummary, schema } from "@wellregarded/db";
import { InMemoryRawArtifactBucket } from "@wellregarded/sources/testing";
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  derivation,
  importRun,
  practice,
  signal,
} from "../../../packages/db/test/factories.js";
import { setupTestDb } from "../../../packages/db/test/harness.js";
import { handleQueueBatch } from "../src/dispatch";
import {
  fakeMessage,
  type IntegrationEnv,
  integrationEnv,
} from "./support/integrationEnv";

const t = setupTestDb();
const { signals, auditLog, proofs } = schema;

let env: IntegrationEnv;

beforeEach(() => {
  resetEnvCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  env = integrationEnv(t.databaseName, new InMemoryRawArtifactBucket());
});

const SPECIFIC_TEXT =
  "Dr. Patel explained every step of my root canal and the front desk " +
  "sorted out my insurance without me asking twice.";

/** A practice + run + signal ready to route. */
async function routableSignal(
  overrides: Partial<Parameters<typeof signal>[1]> = {},
) {
  const p = await practice(t.db);
  const run = await importRun(t.db, { practiceId: p.id });
  const s = await signal(t.db, {
    practiceId: p.id,
    importRunId: run.id,
    originalText: SPECIFIC_TEXT,
    originalRating: "4.0",
    visibility: "private",
    ...overrides,
  });
  return { p, run, s };
}

/**
 * Quiet judgments — no branch fires from these. Urgency is written by the
 * tests that need it (writing the same dimension twice with equal basis
 * would race on created_at ordering; manual-vs-inferred precedence is
 * timestamp-independent and gets its own tests below).
 */
async function quietDerivations(signalId: string) {
  await derivation(t.db, {
    signalId,
    dimension: "sentiment",
    value: "negative",
  });
  await derivation(t.db, {
    signalId,
    dimension: "publication_suitability",
    value: "unsuitable",
  });
}

async function deliverRoute(body: unknown) {
  const message = fakeMessage(body);
  await handleQueueBatch({ queue: "wr-route", messages: [message] }, env);
  return message;
}

function routeBody(s: { id: string; practiceId: string }, runId: string) {
  return {
    signalId: s.id,
    practiceId: s.practiceId,
    importRunId: runId,
    requestId: "req-route-integration",
  };
}

async function auditRowsFor(signalId: string) {
  return t.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.entityId, signalId))
    .orderBy(asc(auditLog.createdAt), asc(auditLog.action));
}

async function pipelineStatusOf(signalId: string) {
  const [row] = await t.db
    .select({ pipelineStatus: signals.pipelineStatus })
    .from(signals)
    .where(eq(signals.id, signalId));
  return row?.pipelineStatus;
}

describe("route branches write their audit + status + stats atomically", () => {
  it("urgency at the threshold: routed_urgent audit, processed status, route_urgent stat", async () => {
    const { p, run, s } = await routableSignal();
    await quietDerivations(s.id);
    await derivation(t.db, {
      signalId: s.id,
      dimension: "urgency",
      value: "high",
      confidence: 0.8,
    });

    const message = await deliverRoute(routeBody(s, run.id));
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();

    const audits = await auditRowsFor(s.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      practiceId: p.id,
      actorType: "system",
      actorId: "pipeline:route",
      action: "signal.routed_urgent",
      entityType: "signals",
      entityId: s.id,
    });
    expect(audits[0]?.payload).toMatchObject({
      urgency: "high",
      basis: "inferred_text",
      importRunId: run.id,
    });

    expect(await pipelineStatusOf(s.id)).toBe("processed");
    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.run.stats).toEqual({ route_urgent: 1 });
  });

  it("public review: entered_review_inbox audit + route_review_inbox stat", async () => {
    const { p, run, s } = await routableSignal({ visibility: "public" });
    await quietDerivations(s.id);

    await deliverRoute(routeBody(s, run.id));

    const audits = await auditRowsFor(s.id);
    expect(audits.map((row) => row.action)).toEqual([
      "signal.entered_review_inbox",
    ]);
    expect(await pipelineStatusOf(s.id)).toBe("processed");
    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.run.stats).toEqual({ route_review_inbox: 1 });
  });

  it("proof candidate: suggested proofs row + proof.suggested audit + route_proof_candidate stat (#96)", async () => {
    const { p, run, s } = await routableSignal();
    await derivation(t.db, {
      signalId: s.id,
      dimension: "sentiment",
      value: "positive",
    });
    await derivation(t.db, {
      signalId: s.id,
      dimension: "publication_suitability",
      value: "suitable",
      confidence: 0.9,
    });

    await deliverRoute(routeBody(s, run.id));

    // The real row: a whole-signal suggestion, display_text untouched.
    const proofRows = await t.db
      .select()
      .from(proofs)
      .where(eq(proofs.signalId, s.id));
    expect(proofRows).toHaveLength(1);
    expect(proofRows[0]).toMatchObject({
      practiceId: p.id,
      signalId: s.id,
      excerptId: null,
      displayText: null,
      status: "suggested",
      approvedBy: null,
    });

    // The audit rides the proofs entity now (not the signal), keyed on
    // the new row's id, in the same routing transaction.
    expect(await auditRowsFor(s.id)).toHaveLength(0);
    const proofAudits = await auditRowsFor(proofRows[0]?.id ?? "");
    expect(proofAudits).toHaveLength(1);
    expect(proofAudits[0]).toMatchObject({
      practiceId: p.id,
      actorType: "system",
      actorId: "pipeline:route",
      action: "proof.suggested",
      entityType: "proofs",
    });
    expect(proofAudits[0]?.payload).toMatchObject({
      sentiment: "positive",
      suitabilityConfidence: 0.9,
      importRunId: run.id,
    });

    expect(await pipelineStatusOf(s.id)).toBe("processed");
    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.run.stats).toEqual({ route_proof_candidate: 1 });
  });

  it("proof candidate re-route: an existing non-archived proof is never duplicated", async () => {
    // Re-classification sends a signal through route again (a NEW message,
    // so the processed-status skip does not apply after the reset below).
    const { p, run, s } = await routableSignal();
    await derivation(t.db, {
      signalId: s.id,
      dimension: "sentiment",
      value: "positive",
    });
    await derivation(t.db, {
      signalId: s.id,
      dimension: "publication_suitability",
      value: "suitable",
      confidence: 0.9,
    });

    await deliverRoute(routeBody(s, run.id));
    await t.db
      .update(signals)
      .set({ pipelineStatus: "pending_route" })
      .where(eq(signals.id, s.id));
    await deliverRoute(routeBody(s, run.id));

    const proofRows = await t.db
      .select()
      .from(proofs)
      .where(eq(proofs.signalId, s.id));
    expect(proofRows).toHaveLength(1);
    // The candidate stat still counts per routing pass; only the row and
    // its audit are idempotent.
    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.run.stats).toEqual({ route_proof_candidate: 2 });
    const proofAudits = await auditRowsFor(proofRows[0]?.id ?? "");
    expect(proofAudits).toHaveLength(1);
  });

  it("quiet path: routed audit only, still processed, route_quiet stat", async () => {
    const { p, run, s } = await routableSignal();
    await quietDerivations(s.id);

    await deliverRoute(routeBody(s, run.id));

    const audits = await auditRowsFor(s.id);
    expect(audits.map((row) => row.action)).toEqual(["signal.routed"]);
    expect(audits[0]?.payload).toMatchObject({ outcome: "no_action" });
    expect(await pipelineStatusOf(s.id)).toBe("processed");
    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.run.stats).toEqual({ route_quiet: 1 });
    expect(summary?.errorCount).toBe(0);
  });

  it("branch independence: a public, urgent, publishable signal takes all three", async () => {
    const { p, run, s } = await routableSignal({ visibility: "public" });
    await derivation(t.db, {
      signalId: s.id,
      dimension: "sentiment",
      value: "positive",
    });
    await derivation(t.db, {
      signalId: s.id,
      dimension: "urgency",
      value: "critical",
      confidence: 0.85,
    });
    await derivation(t.db, {
      signalId: s.id,
      dimension: "publication_suitability",
      value: "suitable",
      confidence: 0.9,
    });

    await deliverRoute(routeBody(s, run.id));

    const audits = await auditRowsFor(s.id);
    expect(audits.map((row) => row.action).sort()).toEqual([
      "signal.entered_review_inbox",
      "signal.routed_urgent",
    ]);
    // The proof branch writes a real suggestion row (audited on the
    // proofs entity) in the same transaction as the other branches.
    const proofRows = await t.db
      .select()
      .from(proofs)
      .where(eq(proofs.signalId, s.id));
    expect(proofRows).toHaveLength(1);
    expect(proofRows[0]?.status).toBe("suggested");
    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.run.stats).toEqual({
      route_urgent: 1,
      route_review_inbox: 1,
      route_proof_candidate: 1,
    });
  });
});

describe("current-derivation resolution feeds routing (manual outranks inferred)", () => {
  it("a manual urgency correction suppresses the recovery branch a newer model row would fire", async () => {
    const { p, run, s } = await routableSignal();
    await quietDerivations(s.id);
    // A staff correction FIRST, then a newer inferred critical: manual
    // must still win (never silently overridden by a newer model run).
    await derivation(t.db, {
      signalId: s.id,
      dimension: "urgency",
      value: "none",
      basis: "manual",
      confidence: 1,
    });
    await derivation(t.db, {
      signalId: s.id,
      dimension: "urgency",
      value: "critical",
      confidence: 0.9,
    });

    await deliverRoute(routeBody(s, run.id));

    const audits = await auditRowsFor(s.id);
    expect(audits.map((row) => row.action)).toEqual(["signal.routed"]);
    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.run.stats).toEqual({ route_quiet: 1 });
  });

  it("conversely, a manual escalation fires recovery over a newer calm inference", async () => {
    const { run, s } = await routableSignal();
    await quietDerivations(s.id);
    await derivation(t.db, {
      signalId: s.id,
      dimension: "urgency",
      value: "critical",
      basis: "manual",
      confidence: 1,
    });
    await derivation(t.db, {
      signalId: s.id,
      dimension: "urgency",
      value: "none",
      confidence: 0.9,
    });

    await deliverRoute(routeBody(s, run.id));

    const audits = await auditRowsFor(s.id);
    expect(audits.map((row) => row.action)).toEqual(["signal.routed_urgent"]);
    expect(audits[0]?.payload).toMatchObject({
      urgency: "critical",
      basis: "manual",
    });
  });
});

describe("idempotent re-delivery (queues are at-least-once)", () => {
  it("a second delivery acks without duplicating audits or stats", async () => {
    const { p, run, s } = await routableSignal({ visibility: "public" });
    await quietDerivations(s.id);
    const body = routeBody(s, run.id);

    await deliverRoute(body);
    const second = await deliverRoute(body);

    expect(second.ack).toHaveBeenCalledOnce();
    expect(second.retry).not.toHaveBeenCalled();
    const audits = await auditRowsFor(s.id);
    expect(audits).toHaveLength(1);
    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.run.stats).toEqual({ route_review_inbox: 1 });
  });
});

describe("missing derivations is a visible failure, never a silent route (#108 req 7)", () => {
  it("classifiable content with no derivations: DLQ forward, recorded on the run, signal not processed", async () => {
    const { p, run, s } = await routableSignal();
    // No derivations written — classify's contract violation.
    const body = routeBody(s, run.id);

    const message = await deliverRoute(body);
    expect(message.ack).toHaveBeenCalledOnce(); // forwarded, not retried
    expect(message.retry).not.toHaveBeenCalled();
    expect(env.ROUTE_DLQ.sent).toHaveLength(1);

    // The platform then delivers that envelope on the DLQ; consume it.
    const dlqMessage = fakeMessage(env.ROUTE_DLQ.sent[0]);
    await handleQueueBatch(
      { queue: "wr-route-dlq", messages: [dlqMessage] },
      env,
    );
    expect(dlqMessage.ack).toHaveBeenCalledOnce();

    const summary = await getImportRunSummary(t.db, p.id, run.id);
    expect(summary?.errorCount).toBe(1);
    expect(summary?.errorSamples[0]).toMatchObject({ stage: "route" });
    expect(summary?.errorSamples[0]?.message).toContain("no derivations");

    // Untouched: replayable once the signal is (re)classified.
    expect(await pipelineStatusOf(s.id)).toBe("pending_dedupe");
    expect(await auditRowsFor(s.id)).toHaveLength(0);
  });

  it("a signal with nothing to judge routes quietly instead of dead-lettering", async () => {
    const { run, s } = await routableSignal({
      originalText: null,
      originalRating: null,
    });

    const message = await deliverRoute(routeBody(s, run.id));

    expect(message.ack).toHaveBeenCalledOnce();
    expect(env.ROUTE_DLQ.sent).toHaveLength(0);
    const audits = await auditRowsFor(s.id);
    expect(audits.map((row) => row.action)).toEqual(["signal.routed"]);
    expect(await pipelineStatusOf(s.id)).toBe("processed");
  });
});
