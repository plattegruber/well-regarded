/**
 * Classify-stage tests (issue #67): `classifySignal` with an in-memory
 * `ClassifyStore` and the fixture-driven `FakeAiProvider` — no network, no
 * Postgres. Real queue ack/retry semantics for this stage live in
 * test/queue.worker.test.ts; DB-side row semantics (including idempotent
 * re-runs against real Postgres) live in
 * packages/db/src/queries/judgments.integration.test.ts.
 */

import {
  FakeAiProvider,
  JUDGMENTS_PROMPT_NAME,
  type JudgmentDerivation,
  type Judgments,
} from "@wellregarded/ai";
import {
  type ClassifyMessage,
  NonRetryableError,
  RetryableError,
} from "@wellregarded/core";
import { describe, expect, it, vi } from "vitest";

import type { PipelineBindings } from "../bindings";
import {
  type ClassifyStore,
  classifySignal,
  type JudgmentSource,
  type SignalForClassification,
} from "./classify";

const uuid = "8a9c1a52-6a54-4d43-9c39-9d5df2bb0e1a";
const otherUuid = "3f2b6a1e-90cd-4f5e-8a2f-1b0f4a7c9d21";
const runUuid = "5d0b8a6e-2f4c-4b7a-9c1d-8e6f0a2b4c6d";

const message: ClassifyMessage = {
  signalId: uuid,
  practiceId: otherUuid,
  importRunId: runUuid,
};

const PIPELINE_MODEL = "claude-haiku-4-5-20251001";

/** FakeAiProvider fixtures — one per scenario the suite drives. */
const fixtures = {
  positive: {
    sentiment: {
      value: "positive",
      confidence: 0.97,
      rationale: "Enthusiastic praise for the hygienist and front desk.",
    },
    urgency: {
      value: "none",
      confidence: 0.95,
      rationale: "Happy patient; nothing to act on.",
    },
    response_risk: {
      value: "low",
      confidence: 0.9,
      rationale: "A generic thank-you is safe.",
    },
    publication_suitability: {
      value: "suitable",
      confidence: 0.85,
      rationale: "Specific, coherent, no third parties named.",
    },
  },
  urgentNegative: {
    sentiment: {
      value: "negative",
      confidence: 0.95,
      rationale: "Angry about ongoing pain after an extraction.",
    },
    urgency: {
      value: "critical",
      confidence: 0.85,
      rationale: "Describes acute post-procedure pain happening now.",
    },
    response_risk: {
      value: "high",
      confidence: 0.8,
      rationale:
        "Mentions a specific procedure; replying risks confirming care.",
    },
    publication_suitability: {
      value: "unsuitable",
      confidence: 0.9,
      rationale: "Protected health details the author may regret sharing.",
    },
  },
  ambiguousLowConfidence: {
    sentiment: {
      value: "mixed",
      confidence: 0.55,
      rationale: "Praise for the dentist but an unresolved billing thread.",
    },
    urgency: {
      value: "medium",
      confidence: 0.4,
      rationale: "Possibly an unresolved billing complaint; hard to tell.",
    },
    response_risk: {
      value: "medium",
      confidence: 0.5,
      rationale: "Billing mention needs a careful reply.",
    },
    publication_suitability: {
      value: "needs_review",
      confidence: 0.45,
      rationale: "Borderline: billing details may identify the visit.",
    },
  },
} satisfies Record<string, Judgments>;

interface StoreState {
  inserted: { message: ClassifyMessage; rows: readonly JudgmentDerivation[] }[];
  probes: JudgmentSource[];
}

function makeStore(
  signal: SignalForClassification | undefined,
  options: { existing?: (source: JudgmentSource) => boolean } = {},
): ClassifyStore & StoreState {
  const state: StoreState = { inserted: [], probes: [] };
  return {
    ...state,
    getSignal: async () => signal,
    hasJudgments: async (_signalId, source) => {
      state.probes.push(source);
      return options.existing?.(source) ?? false;
    },
    insertJudgments: async (insertMessage, rows) => {
      state.inserted.push({ message: insertMessage, rows });
    },
  };
}

function makeEnv() {
  const send = vi.fn().mockResolvedValue(undefined);
  const env = { ENVIRONMENT: "local", ROUTE_QUEUE: { send } };
  return { env: env as unknown as PipelineBindings, routeSend: send };
}

function signalWith(
  overrides: Partial<SignalForClassification>,
): SignalForClassification {
  return {
    originalText: "Everyone was kind and the cleaning was painless.",
    originalRating: "5.0",
    retentionState: "active",
    ...overrides,
  };
}

function deps(
  store: ClassifyStore,
  provider?: FakeAiProvider,
): Parameters<typeof classifySignal>[2] {
  return { store, provider, pipelineModel: PIPELINE_MODEL };
}

describe("classifySignal — text path (one model call, four rows)", () => {
  it("classifies a positive review and enqueues the route message", async () => {
    const provider = new FakeAiProvider({
      [JUDGMENTS_PROMPT_NAME]: [fixtures.positive],
    });
    const store = makeStore(signalWith({}));
    const { env, routeSend } = makeEnv();

    await classifySignal(message, env, deps(store, provider));

    // Exactly one call, judgments purpose, billed to the signal's practice.
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.opts).toEqual({
      purpose: "judgments",
      practiceId: otherUuid,
      model: "pipeline",
    });
    expect(provider.calls[0]?.prompt.user).toContain(
      "Everyone was kind and the cleaning was painless.",
    );

    // Four rows: basis inferred_text, model_version from the AI result.
    expect(store.inserted).toHaveLength(1);
    const rows = store.inserted[0]?.rows ?? [];
    expect(rows.map((row) => row.dimension)).toEqual([
      "sentiment",
      "urgency",
      "response_risk",
      "publication_suitability",
    ]);
    for (const row of rows) {
      expect(row.basis).toBe("inferred_text");
      expect(row.modelVersion).toBe("fake-pipeline");
      expect(row.rationale.length).toBeGreaterThan(0);
    }

    expect(routeSend).toHaveBeenCalledExactlyOnceWith({
      signalId: uuid,
      practiceId: otherUuid,
      importRunId: runUuid,
    });
  });

  it("stores an urgent-negative complaint verbatim (confident critical stays critical)", async () => {
    const provider = new FakeAiProvider({
      [JUDGMENTS_PROMPT_NAME]: [fixtures.urgentNegative],
    });
    const store = makeStore(
      signalWith({
        originalText:
          "Still in severe pain three days after my extraction and nobody calls back.",
        originalRating: "1.0",
      }),
    );
    const { env } = makeEnv();

    await classifySignal(message, env, deps(store, provider));

    const byDimension = Object.fromEntries(
      (store.inserted[0]?.rows ?? []).map((row) => [row.dimension, row]),
    );
    expect(byDimension.sentiment).toMatchObject({ value: "negative" });
    expect(byDimension.urgency).toMatchObject({
      value: "critical",
      confidence: 0.85,
    });
    expect(byDimension.response_risk).toMatchObject({ value: "high" });
    expect(byDimension.publication_suitability).toMatchObject({
      value: "unsuitable",
    });
  });

  it("floors low-confidence urgency UP one level, keeping the model's confidence", async () => {
    const provider = new FakeAiProvider({
      [JUDGMENTS_PROMPT_NAME]: [fixtures.ambiguousLowConfidence],
    });
    const store = makeStore(
      signalWith({
        originalText:
          "Dr. Lee is great but I think they may have double-billed me, hard to say.",
      }),
    );
    const { env } = makeEnv();

    await classifySignal(message, env, deps(store, provider));

    const urgency = (store.inserted[0]?.rows ?? []).find(
      (row) => row.dimension === "urgency",
    );
    // medium @ 0.4 confidence → stored as high (never down), confidence kept.
    expect(urgency).toMatchObject({ value: "high", confidence: 0.4 });
  });

  it("skips the model call and the write when this model version already judged the signal", async () => {
    const provider = new FakeAiProvider(); // no fixtures: any call would throw
    const store = makeStore(signalWith({}), {
      existing: (source) =>
        "modelVersion" in source && source.modelVersion === PIPELINE_MODEL,
    });
    const { env, routeSend } = makeEnv();

    await classifySignal(message, env, deps(store, provider));

    expect(provider.calls).toHaveLength(0);
    expect(store.inserted).toHaveLength(0);
    // Route still fires — the route stage owns idempotency on its side.
    expect(routeSend).toHaveBeenCalledTimes(1);
  });

  it("throws RetryableError (actionable) when text needs a model but no provider is configured", async () => {
    const store = makeStore(signalWith({}));
    const { env, routeSend } = makeEnv();

    await expect(
      classifySignal(message, env, deps(store, undefined)),
    ).rejects.toThrow(RetryableError);
    await expect(
      classifySignal(message, env, deps(store, undefined)),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(store.inserted).toHaveLength(0);
    expect(routeSend).not.toHaveBeenCalled();
  });
});

describe("classifySignal — rating-only path (no model call)", () => {
  it("derives deterministic judgments from a bare rating", async () => {
    const provider = new FakeAiProvider(); // any call would throw
    const store = makeStore(
      signalWith({ originalText: null, originalRating: "2.0" }),
    );
    const { env, routeSend } = makeEnv();

    await classifySignal(message, env, deps(store, provider));

    expect(provider.calls).toHaveLength(0);
    const rows = store.inserted[0]?.rows ?? [];
    const byDimension = Object.fromEntries(
      rows.map((row) => [row.dimension, row]),
    );
    expect(byDimension.sentiment).toMatchObject({
      value: "negative",
      confidence: 0.6,
      basis: "source_metadata",
      modelVersion: null,
    });
    expect(byDimension.urgency).toMatchObject({ value: "none" });
    expect(byDimension.publication_suitability).toMatchObject({
      value: "unsuitable",
    });
    expect(byDimension.response_risk).toBeUndefined();
    expect(routeSend).toHaveBeenCalledTimes(1);
  });

  it("treats short text (< 3 words) as rating-only and bumps 1-star urgency to low", async () => {
    const store = makeStore(
      signalWith({ originalText: "Awful.", originalRating: "1.0" }),
    );
    const { env } = makeEnv();

    await classifySignal(message, env, deps(store, new FakeAiProvider()));

    const urgency = (store.inserted[0]?.rows ?? []).find(
      (row) => row.dimension === "urgency",
    );
    expect(urgency).toMatchObject({ value: "low", basis: "source_metadata" });
  });

  it("is idempotent: an existing source_metadata judgment suppresses the rewrite", async () => {
    const store = makeStore(
      signalWith({ originalText: "", originalRating: "4.0" }),
      { existing: (source) => "basis" in source },
    );
    const { env, routeSend } = makeEnv();

    await classifySignal(message, env, deps(store, new FakeAiProvider()));

    expect(store.inserted).toHaveLength(0);
    expect(routeSend).toHaveBeenCalledTimes(1);
  });

  it("works without a provider — the kill-switch/no-key posture never blocks deterministic rows", async () => {
    const store = makeStore(
      signalWith({ originalText: "   ", originalRating: "5.0" }),
    );
    const { env } = makeEnv();

    await classifySignal(message, env, deps(store, undefined));

    expect(store.inserted).toHaveLength(1);
  });
});

describe("classifySignal — edge signals", () => {
  it("writes nothing for a signal with neither text nor rating, but still routes", async () => {
    const provider = new FakeAiProvider();
    const store = makeStore(
      signalWith({ originalText: null, originalRating: null }),
    );
    const { env, routeSend } = makeEnv();

    await classifySignal(message, env, deps(store, provider));

    expect(provider.calls).toHaveLength(0);
    expect(store.inserted).toHaveLength(0);
    expect(routeSend).toHaveBeenCalledTimes(1);
  });

  it("skips redacted/purged signals without judging the void", async () => {
    const provider = new FakeAiProvider();
    const store = makeStore(
      signalWith({ retentionState: "redacted", originalText: null }),
    );
    const { env, routeSend } = makeEnv();

    await classifySignal(message, env, deps(store, provider));

    expect(provider.calls).toHaveLength(0);
    expect(store.inserted).toHaveLength(0);
    expect(routeSend).toHaveBeenCalledTimes(1);
  });

  it("throws NonRetryableError when the signal row does not exist", async () => {
    const store = makeStore(undefined);
    const { env, routeSend } = makeEnv();

    await expect(
      classifySignal(message, env, deps(store, new FakeAiProvider())),
    ).rejects.toThrow(NonRetryableError);
    expect(routeSend).not.toHaveBeenCalled();
  });
});
