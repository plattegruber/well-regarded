/**
 * Route-stage tests (issue #108): `decideRoutes` (the pure policy) and
 * `routeSignal` with an in-memory `RouteStore` and recording sinks — no
 * network, no Postgres. Real queue ack/retry semantics for this stage live
 * in test/queue.worker.test.ts; real-store row semantics (audit rows,
 * pipeline_status, import-run stats, manual-outranks-inferred) live in
 * test/route.integration.test.ts.
 */

import {
  NonRetryableError,
  RetryableError,
  type RouteMessage,
  type UrgencyLevel,
} from "@wellregarded/core";
import { describe, expect, it, vi } from "vitest";

import {
  auditOnlyRecoverySink,
  classifyShouldHaveJudged,
  decideRoutes,
  defaultRoutingConfig,
  isSpecificText,
  MIN_PROOF_TEXT_LENGTH,
  type ProofSink,
  proofSuggestionSink,
  type RecoverySink,
  type RouteDeps,
  type RouteStore,
  type RoutingDerivations,
  type RoutingJudgment,
  type RoutingOutcome,
  routeSignal,
  type SignalForRouting,
} from "./route";

const uuid = "8a9c1a52-6a54-4d43-9c39-9d5df2bb0e1a";
const otherUuid = "3f2b6a1e-90cd-4f5e-8a2f-1b0f4a7c9d21";
const runUuid = "5d0b8a6e-2f4c-4b7a-9c1d-8e6f0a2b4c6d";

const message: RouteMessage = {
  signalId: uuid,
  practiceId: otherUuid,
  importRunId: runUuid,
  requestId: "req-route-test",
};

const SPECIFIC_TEXT =
  "Dr. Patel explained every step of my root canal and the front desk " +
  "sorted my insurance without me asking twice.";

function signalWith(overrides: Partial<SignalForRouting>): SignalForRouting {
  return {
    visibility: "private",
    originalText: SPECIFIC_TEXT,
    originalRating: "4.0",
    retentionState: "active",
    pipelineStatus: "pending_route",
    classificationPending: false,
    ...overrides,
  };
}

function judgment(
  value: unknown,
  confidence = 0.9,
  basis: RoutingJudgment["basis"] = "inferred_text",
): RoutingJudgment {
  return { value, confidence, basis };
}

function derivationsWith(
  partial: Partial<RoutingDerivations>,
): RoutingDerivations {
  return {
    sentiment: undefined,
    urgency: undefined,
    response_risk: undefined,
    publication_suitability: undefined,
    ...partial,
  };
}

/** Derivations that fire no branch: calm, negative, unsuitable. */
function quietDerivations(): RoutingDerivations {
  return derivationsWith({
    sentiment: judgment("negative"),
    urgency: judgment("low"),
    response_risk: judgment("medium"),
    publication_suitability: judgment("unsuitable"),
  });
}

interface StoreState {
  committed: { message: RouteMessage; outcome: RoutingOutcome }[];
}

function makeStore(
  signal: SignalForRouting | undefined,
  derivations: RoutingDerivations = derivationsWith({}),
  options: { commitError?: Error } = {},
): RouteStore & StoreState {
  const state: StoreState = { committed: [] };
  return {
    ...state,
    getSignal: async () => signal,
    getCurrentDerivations: async () => derivations,
    commitRouting: async (commitMessage, outcome) => {
      if (options.commitError) throw options.commitError;
      state.committed.push({ message: commitMessage, outcome });
    },
  };
}

function recordingSinks() {
  const recoveryCalls: { signal: SignalForRouting; urgency: UrgencyLevel }[] =
    [];
  const proofCalls: SignalForRouting[] = [];
  const recovery: RecoverySink = {
    openRecoveryItem: async (signal, urgency, context) => {
      recoveryCalls.push({ signal, urgency });
      // Delegate to the real interim sink so the queued audit/stat shape
      // stays the production one.
      await auditOnlyRecoverySink.openRecoveryItem(signal, urgency, context);
    },
  };
  const proof: ProofSink = {
    suggestProof: async (signal, context) => {
      proofCalls.push(signal);
      await proofSuggestionSink.suggestProof(signal, context);
    },
  };
  return { recovery, proof, recoveryCalls, proofCalls };
}

function deps(
  store: RouteStore,
  sinks = recordingSinks(),
  config = defaultRoutingConfig,
): RouteDeps {
  return { store, recovery: sinks.recovery, proof: sinks.proof, config };
}

describe("decideRoutes — urgency → recovery branch", () => {
  it("fires at exactly the default threshold (high)", () => {
    const decisions = decideRoutes(
      signalWith({}),
      derivationsWith({ urgency: judgment("high", 0.8) }),
      defaultRoutingConfig,
    );
    expect(decisions).toEqual([
      { kind: "recovery", urgency: "high", confidence: 0.8 },
    ]);
  });

  it("fires above the threshold and not below it", () => {
    const at = (urgency: string) =>
      decideRoutes(
        signalWith({}),
        derivationsWith({ urgency: judgment(urgency) }),
        defaultRoutingConfig,
      );
    expect(at("critical")).toHaveLength(1);
    expect(at("medium")).toHaveLength(0);
    expect(at("none")).toHaveLength(0);
  });

  it("respects a raised per-practice threshold", () => {
    const config = { urgencyThreshold: "critical" as const };
    const at = (urgency: string) =>
      decideRoutes(
        signalWith({}),
        derivationsWith({ urgency: judgment(urgency) }),
        config,
      );
    expect(at("high")).toHaveLength(0);
    expect(at("critical")).toHaveLength(1);
  });

  it("ignores a value outside the urgency vocabulary rather than guessing", () => {
    const decisions = decideRoutes(
      signalWith({}),
      derivationsWith({ urgency: judgment("urgent") }),
      defaultRoutingConfig,
    );
    expect(decisions).toHaveLength(0);
  });
});

describe("decideRoutes — public review → inbox branch", () => {
  it("routes public signals to the review inbox, derivations or not", () => {
    const decisions = decideRoutes(
      signalWith({ visibility: "public" }),
      derivationsWith({}),
      defaultRoutingConfig,
    );
    expect(decisions).toEqual([{ kind: "review_inbox" }]);
  });

  it("never routes private signals to the inbox", () => {
    const decisions = decideRoutes(
      signalWith({ visibility: "private" }),
      quietDerivations(),
      defaultRoutingConfig,
    );
    expect(decisions).toHaveLength(0);
  });
});

describe("decideRoutes — proof-candidate branch", () => {
  const publishable = () =>
    derivationsWith({
      sentiment: judgment("positive"),
      publication_suitability: judgment("suitable", 0.85),
    });

  it("fires for positive + specific text + confidently suitable", () => {
    const decisions = decideRoutes(
      signalWith({}),
      publishable(),
      defaultRoutingConfig,
    );
    expect(decisions).toEqual([
      { kind: "proof_candidate", suitabilityConfidence: 0.85 },
    ]);
  });

  it("requires adequate suitability confidence", () => {
    const derivations = publishable();
    derivations.publication_suitability = judgment("suitable", 0.5);
    expect(
      decideRoutes(signalWith({}), derivations, defaultRoutingConfig),
    ).toHaveLength(0);
  });

  it("requires the suitable judgment, not needs_review", () => {
    const derivations = publishable();
    derivations.publication_suitability = judgment("needs_review", 0.9);
    expect(
      decideRoutes(signalWith({}), derivations, defaultRoutingConfig),
    ).toHaveLength(0);
  });

  it("requires positive sentiment (mixed is not proof)", () => {
    const derivations = publishable();
    derivations.sentiment = judgment("mixed");
    expect(
      decideRoutes(signalWith({}), derivations, defaultRoutingConfig),
    ).toHaveLength(0);
  });

  it("requires specific text — a bare 'Great!' is not a testimonial", () => {
    expect(
      decideRoutes(
        signalWith({ originalText: "Great!" }),
        publishable(),
        defaultRoutingConfig,
      ),
    ).toHaveLength(0);
  });
});

describe("decideRoutes — branch independence and the quiet path", () => {
  it("a public, urgent, publishable signal takes all three branches", () => {
    const decisions = decideRoutes(
      signalWith({ visibility: "public" }),
      derivationsWith({
        sentiment: judgment("positive"),
        urgency: judgment("critical"),
        publication_suitability: judgment("suitable", 0.9),
      }),
      defaultRoutingConfig,
    );
    expect(decisions.map((decision) => decision.kind)).toEqual([
      "recovery",
      "review_inbox",
      "proof_candidate",
    ]);
  });

  it("returns nothing when no branch fires (the quiet path)", () => {
    expect(
      decideRoutes(signalWith({}), quietDerivations(), defaultRoutingConfig),
    ).toHaveLength(0);
  });
});

describe("isSpecificText", () => {
  it("accepts text at/above the minimum and rejects below it", () => {
    expect(isSpecificText("x".repeat(MIN_PROOF_TEXT_LENGTH))).toBe(true);
    expect(isSpecificText("x".repeat(MIN_PROOF_TEXT_LENGTH - 1))).toBe(false);
  });

  it("rejects null and whitespace padding", () => {
    expect(isSpecificText(null)).toBe(false);
    expect(isSpecificText(`  ${"x".repeat(10)}  `.padEnd(200, " "))).toBe(
      false,
    );
  });
});

describe("classifyShouldHaveJudged", () => {
  it("is true for classifiable text and for a bare rating", () => {
    expect(classifyShouldHaveJudged(signalWith({}))).toBe(true);
    expect(
      classifyShouldHaveJudged(
        signalWith({ originalText: null, originalRating: "2.0" }),
      ),
    ).toBe(true);
  });

  it("is false when there was never anything to judge", () => {
    expect(
      classifyShouldHaveJudged(
        signalWith({ originalText: null, originalRating: null }),
      ),
    ).toBe(false);
    expect(
      classifyShouldHaveJudged(signalWith({ retentionState: "redacted" })),
    ).toBe(false);
  });
});

describe("routeSignal — branch execution and the routing commit", () => {
  it("urgent: calls the recovery sink and commits the routed_urgent audit + stat", async () => {
    const store = makeStore(
      signalWith({}),
      derivationsWith({ urgency: judgment("critical", 0.85) }),
    );
    const sinks = recordingSinks();

    await routeSignal(message, deps(store, sinks));

    expect(sinks.recoveryCalls).toEqual([
      {
        signal: expect.objectContaining({ visibility: "private" }),
        urgency: "critical",
      },
    ]);
    expect(sinks.proofCalls).toHaveLength(0);
    expect(store.committed).toHaveLength(1);
    const outcome = store.committed[0]?.outcome;
    expect(outcome?.audits).toEqual([
      {
        action: "signal.routed_urgent",
        payload: {
          urgency: "critical",
          confidence: 0.85,
          basis: "inferred_text",
          importRunId: runUuid,
        },
      },
    ]);
    expect(outcome?.stats).toEqual({ route_urgent: 1 });
  });

  it("public: commits the entered_review_inbox audit + stat", async () => {
    const store = makeStore(
      signalWith({ visibility: "public" }),
      quietDerivations(),
    );

    await routeSignal(message, deps(store));

    const outcome = store.committed[0]?.outcome;
    expect(outcome?.audits).toEqual([
      {
        action: "signal.entered_review_inbox",
        payload: { importRunId: runUuid },
      },
    ]);
    expect(outcome?.stats).toEqual({ route_review_inbox: 1 });
  });

  it("proof candidate: calls the proof sink and commits its suggest_proof effect + stat", async () => {
    const store = makeStore(
      signalWith({}),
      derivationsWith({
        sentiment: judgment("positive"),
        publication_suitability: judgment("suitable", 0.9),
      }),
    );
    const sinks = recordingSinks();

    await routeSignal(message, deps(store, sinks));

    expect(sinks.proofCalls).toHaveLength(1);
    const outcome = store.committed[0]?.outcome;
    // No queued audit: `suggestProof` in @wellregarded/db writes the
    // `proof.suggested` row keyed on the inserted proof's id, inside the
    // routing transaction (see the effect execution in commitRouting).
    expect(outcome?.audits).toEqual([]);
    expect(outcome?.effects).toEqual([
      {
        kind: "suggest_proof",
        auditPayload: {
          sentiment: "positive",
          suitabilityConfidence: 0.9,
          importRunId: runUuid,
        },
      },
    ]);
    expect(outcome?.stats).toEqual({ route_proof_candidate: 1 });
  });

  it("quiet path: no sinks, one routed audit, status still committed", async () => {
    const store = makeStore(signalWith({}), quietDerivations());
    const sinks = recordingSinks();

    await routeSignal(message, deps(store, sinks));

    expect(sinks.recoveryCalls).toHaveLength(0);
    expect(sinks.proofCalls).toHaveLength(0);
    expect(store.committed).toHaveLength(1);
    const outcome = store.committed[0]?.outcome;
    expect(outcome?.audits).toEqual([
      {
        action: "signal.routed",
        payload: { outcome: "no_action", importRunId: runUuid },
      },
    ]);
    expect(outcome?.stats).toEqual({ route_quiet: 1 });
  });

  it("all three branches commit in ONE outcome", async () => {
    const store = makeStore(
      signalWith({ visibility: "public" }),
      derivationsWith({
        sentiment: judgment("positive"),
        urgency: judgment("high"),
        publication_suitability: judgment("suitable", 0.9),
      }),
    );

    await routeSignal(message, deps(store));

    expect(store.committed).toHaveLength(1);
    const outcome = store.committed[0]?.outcome;
    expect(outcome?.audits.map((audit) => audit.action)).toEqual([
      "signal.routed_urgent",
      "signal.entered_review_inbox",
    ]);
    expect(outcome?.effects.map((effect) => effect.kind)).toEqual([
      "suggest_proof",
    ]);
    expect(outcome?.stats).toEqual({
      route_urgent: 1,
      route_review_inbox: 1,
      route_proof_candidate: 1,
    });
  });
});

describe("routeSignal — idempotency and failure vocabulary", () => {
  it("skips everything on re-delivery of an already-processed signal", async () => {
    const store = makeStore(
      signalWith({ pipelineStatus: "processed", visibility: "public" }),
      derivationsWith({ urgency: judgment("critical") }),
    );
    const sinks = recordingSinks();

    await routeSignal(message, deps(store, sinks));

    expect(sinks.recoveryCalls).toHaveLength(0);
    expect(store.committed).toHaveLength(0);
  });

  it("throws NonRetryableError when the signal row does not exist", async () => {
    const store = makeStore(undefined);
    await expect(routeSignal(message, deps(store))).rejects.toThrow(
      NonRetryableError,
    );
    expect(store.committed).toHaveLength(0);
  });

  it("throws NonRetryableError when classify should have judged but wrote nothing", async () => {
    const store = makeStore(signalWith({}), derivationsWith({}));
    await expect(routeSignal(message, deps(store))).rejects.toThrow(
      /no derivations/,
    );
    await expect(routeSignal(message, deps(store))).rejects.toThrow(
      NonRetryableError,
    );
    expect(store.committed).toHaveLength(0);
  });

  it("routes a deferred-classification signal instead of dead-lettering it (issue #75)", async () => {
    // The kill switch / budget cap left the signal unclassified with the
    // marker set: absence is sanctioned. A public review still enters the
    // inbox (visible, honestly unclassified) rather than DLQing.
    const store = makeStore(
      signalWith({ visibility: "public", classificationPending: true }),
      derivationsWith({}),
    );

    await routeSignal(message, deps(store));

    expect(store.committed).toHaveLength(1);
    expect(store.committed[0]?.outcome.audits).toEqual([
      expect.objectContaining({ action: "signal.entered_review_inbox" }),
    ]);
  });

  it("a deferred signal with a keyword-fallback urgency still opens recovery (issue #75)", async () => {
    const store = makeStore(
      signalWith({ classificationPending: true }),
      derivationsWith({
        urgency: judgment("high", 0.3),
      }),
    );
    const sinks = recordingSinks();

    await routeSignal(message, deps(store, sinks));

    expect(sinks.recoveryCalls).toHaveLength(1);
    expect(sinks.recoveryCalls[0]?.urgency).toBe("high");
  });

  it("takes the quiet path for a legitimately unjudged signal (no text, no rating)", async () => {
    const store = makeStore(
      signalWith({ originalText: null, originalRating: null }),
      derivationsWith({}),
    );

    await routeSignal(message, deps(store));

    expect(store.committed[0]?.outcome.audits).toEqual([
      expect.objectContaining({ action: "signal.routed" }),
    ]);
  });

  it("takes the quiet path for redacted signals instead of dead-lettering them", async () => {
    const store = makeStore(
      signalWith({ retentionState: "redacted", originalText: null }),
      derivationsWith({}),
    );

    await routeSignal(message, deps(store));

    expect(store.committed).toHaveLength(1);
  });

  it("wraps a commit failure in RetryableError (safe: nothing committed)", async () => {
    const store = makeStore(signalWith({}), quietDerivations(), {
      commitError: new Error("connection reset"),
    });
    await expect(routeSignal(message, deps(store))).rejects.toThrow(
      RetryableError,
    );
    await expect(routeSignal(message, deps(store))).rejects.toThrow(
      /connection reset/,
    );
  });

  it("a partially-judged signal routes on what exists (rating-only: no response_risk)", async () => {
    // The rating-only classify path writes 3 of 4 dimensions — that is a
    // judged signal, not a missing-derivations contract violation.
    const store = makeStore(
      signalWith({ originalText: null, originalRating: "1.0" }),
      derivationsWith({
        sentiment: judgment("negative", 0.6, "source_metadata"),
        urgency: judgment("low", 0.6, "source_metadata"),
        publication_suitability: judgment("unsuitable", 0.9, "source_metadata"),
      }),
    );

    await routeSignal(message, deps(store));

    expect(store.committed[0]?.outcome.stats).toEqual({ route_quiet: 1 });
  });
});

describe("routeSignal — logging", () => {
  it("logs done with the branches taken, bound to the message requestId", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const store = makeStore(
      signalWith({ visibility: "public" }),
      quietDerivations(),
    );
    await routeSignal(message, deps(store));
    const records = logSpy.mock.calls.map((call) =>
      JSON.parse(String(call[0])),
    );
    const done = records.find((record) => record.msg === "pipeline.route.done");
    expect(done).toMatchObject({
      worker: "pipeline",
      stage: "route",
      requestId: "req-route-test",
      branches: ["review_inbox"],
    });
    logSpy.mockRestore();
  });
});
