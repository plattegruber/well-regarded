/**
 * Classify stage — consumer of `wr-classify` (issues #67 + #69 + #71,
 * Epic #9).
 *
 * TWO sequential AI passes per text signal, in one consumer invocation:
 *
 * 1. **Judgments** (#67): one Haiku-lane call returns all four judgments
 *    (sentiment, urgency, response risk, publication suitability); each
 *    becomes a `derivations` row with confidence, rationale, basis
 *    `inferred_text`, and the concrete `model_version` from the AI result.
 * 2. **Excerpts** (#69): a second Haiku-lane call splits multi-topic text
 *    into aspect-level `proof_excerpts` rows — verbatim substrings ONLY,
 *    validated server-side (see `@wellregarded/ai` src/prompts/excerpts.ts
 *    for the tolerance); signals under 15 words skip the model and store
 *    the whole text as one excerpt. Extraction runs regardless of
 *    sentiment/suitability — Recovery and Coverage need aspect granularity
 *    for private/negative signals too; suitability only gates publication.
 *    New excerpts are then embedded inline (#71, Workers AI bge-m3 via the
 *    injected `EmbeddingProvider`); an embedding failure never fails the
 *    message — the vector stays NULL and the backfill Workflow in
 *    workers/jobs sweeps it up.
 *
 * Judgments run first: their output is needed for routing even when the
 * excerpt pass fails. The judgment/excerpt-shaped logic (prompts, schemas,
 * urgency floor, substring validator, deterministic fallbacks) lives in
 * `@wellregarded/ai`; this consumer stays thin.
 *
 * Paths per signal (see `classifySignal`):
 * - **Text** (≥ 3 words): judgments call → four rows; then excerpt pass →
 *   `proof_excerpts` rows (+ inline embeddings). Low-confidence urgency
 *   (< 0.5) is floored UP one level (`applyUrgencyFloor`) — a missed
 *   urgent complaint is a patient walking away in pain; a false alarm
 *   costs a human ten seconds.
 * - **Rating only** (empty/short text, has a rating): NO model call —
 *   deterministic rows via `ratingOnlyDerivations`, basis
 *   `source_metadata`, and no excerpts (nothing quotable). Cost matters: a
 *   2,000-review CSV backfill should not spend 2,000 calls on bare star
 *   ratings.
 * - **Neither**: nothing to judge; log and move on.
 * Every path ends by enqueueing a RouteMessage — routing decides what the
 * derivations (or their absence) mean.
 *
 * Idempotency: Queues deliver at-least-once, so before calling the model
 * we probe for existing derivations from this model version (the
 * deterministic path probes basis `source_metadata`), and the excerpt pass
 * probes for existing `proof_excerpts` rows — each pass skips its write
 * independently on redelivery (a redelivery after judgments-but-no-excerpts
 * re-runs only the excerpt pass). The route enqueue is deliberately NOT
 * deduplicated — the route stage must be idempotent anyway, and a duplicate
 * RouteMessage is harmless where a missing one is not.
 *
 * Cost/backpressure: ~2 Haiku calls per text signal (judgments + excerpts)
 * plus one Workers AI embedding call. The queue's
 * `max_batch_size`/`max_retries` (wrangler.jsonc) drain a big import
 * gradually, and `AnthropicProvider`'s 429 backoff (#63) absorbs bursts —
 * this handler adds no throttling of its own. Cost accounting rides the
 * injected `AiCallSink` (purposes `"judgments"` and `"excerpts"`, billed
 * to the signal's practice).
 */

import {
  type AiProvider,
  AnthropicProvider,
  countWords,
  createWorkersAiEmbedder,
  type EmbeddingProvider,
  EXCERPT_MIN_MODEL_WORDS,
  ExcerptsSchema,
  excerptsPrompt,
  excerptsRetryPrompt,
  hasClassifiableText,
  type JudgmentDerivation,
  JudgmentsSchema,
  judgmentsPrompt,
  judgmentsToDerivations,
  keywordUrgencyDerivation,
  matchUrgentKeywords,
  type PlannedExcerpt,
  ratingOnlyDerivations,
  URGENT_KEYWORD_MODEL_VERSION,
  validateExcerpts,
  wholeTextExcerpt,
} from "@wellregarded/ai";
import {
  type ClassifyMessage,
  createLogger,
  fallbackRequestId,
  getEnv,
  NonRetryableError,
  pipelineEnvSchema,
  RetryableError,
  type RouteMessage,
} from "@wellregarded/core";
import {
  clearClassificationDeferred,
  createAiCallSink,
  createDb,
  type Db,
  type DerivationDimension,
  getSignal,
  insertDerivations,
  insertProofExcerpts,
  markClassificationDeferred,
  practiceAiStatus,
  setProofExcerptEmbeddings,
  signalHasDerivations,
  signalHasProofExcerpts,
} from "@wellregarded/db";

import type { PipelineBindings } from "../bindings";
import type { StageHandler } from "./types";

/** What the stage reads off a `signals` row. */
export interface SignalForClassification {
  originalText: string | null;
  /** numeric(2,1) arrives from postgres-js as a string, e.g. `"4.0"`. */
  originalRating: string | null;
  /** `redacted`/`purged` signals have had their content nulled by design. */
  retentionState: "active" | "redacted" | "purged";
  /** Non-null = a previous delivery deferred classification (issue #75);
   * a successful real pass clears it. */
  classificationDeferredAt: Date | null;
}

/** Where existing judgments came from — the idempotency probe's key. */
export type JudgmentSource =
  | { modelVersion: string }
  | { basis: "source_metadata" };

/** An inserted `proof_excerpts` row, as the inline embed pass needs it. */
export interface StoredExcerpt {
  id: string;
  text: string;
}

/** One inline embedding write. */
export interface ExcerptEmbeddingUpdate {
  id: string;
  embedding: number[];
  embeddingModel: string;
}

/**
 * The stage's narrow persistence seam. Production is `createClassifyStore`
 * over the Hyperdrive-backed client; workerd tests inject an in-memory
 * fake (no Postgres inside the test pool).
 */
export interface ClassifyStore {
  getSignal(signalId: string): Promise<SignalForClassification | undefined>;
  hasJudgments(signalId: string, source: JudgmentSource): Promise<boolean>;
  insertJudgments(
    message: ClassifyMessage,
    rows: readonly JudgmentDerivation[],
  ): Promise<void>;
  /** The excerpt pass's idempotency probe (issue #69 requirement 6). */
  hasExcerpts(signalId: string): Promise<boolean>;
  /** One multi-row INSERT; returns ids for the inline embed pass. */
  insertExcerpts(
    message: ClassifyMessage,
    excerpts: readonly PlannedExcerpt[],
  ): Promise<StoredExcerpt[]>;
  /** Fill `embedding` + `embedding_model` on freshly inserted rows. */
  setExcerptEmbeddings(
    updates: readonly ExcerptEmbeddingUpdate[],
  ): Promise<void>;
  /** Set the issue-#75 deferral marker (idempotent — first timestamp wins). */
  markClassificationDeferred(signalId: string): Promise<void>;
  /** Clear the marker after a successful real classification pass. */
  clearClassificationDeferred(signalId: string): Promise<void>;
}

/**
 * The kill-switch / budget gate (issue #75) — resolved once per message,
 * BEFORE any provider call (the issue's "check the budget before each
 * provider call": both of this stage's calls sit behind this one gate).
 * `softAlert` carries the ≥ 80% state so the stage can log the structured
 * warning without a second query.
 */
export type ClassifyAiGate =
  | {
      allow: true;
      softAlert?: { spentCents: number; budgetCents: number } | undefined;
    }
  | { allow: false; reason: "kill_switch" | "budget_exhausted" };

export interface ClassifyDeps {
  store: ClassifyStore;
  /**
   * Absent when `ANTHROPIC_API_KEY` is not configured: the deterministic
   * rating-only path still works; text signals throw `RetryableError` with
   * an actionable message (retry → DLQ, replayable once the key is set).
   */
  provider?: AiProvider | undefined;
  /**
   * Absent when the `AI` binding is not configured (issue #71). Unlike a
   * missing Anthropic key this does NOT block the message: excerpts are
   * stored with a NULL embedding and the backfill Workflow sweeps them up.
   */
  embedder?: EmbeddingProvider | undefined;
  /**
   * Concrete pipeline-lane model id (`PIPELINE_MODEL`, or the practice's
   * override once resolved) — the idempotency probe's model_version. Pin
   * dated ids (the env default is one) so this matches what the API
   * reports back in `usage.model`.
   */
  pipelineModel: string;
  /**
   * The issue-#75 gate: kill switch (env `AI_DISABLED` / practice
   * `ai.disabled`) and monthly budget, resolved per message. Absent (e.g.
   * older tests) = always allowed. When it denies, the stage defers:
   * signal stays unclassified, marker set, keyword urgency fallback runs,
   * route still enqueued — nothing lost, only deferred.
   */
  aiGate?: ((practiceId: string) => Promise<ClassifyAiGate>) | undefined;
}

function stageLogger(message: ClassifyMessage) {
  // The dispatcher guarantees a requestId on delivered messages (issue
  // #64); the fallback only fires for direct test invocations.
  return createLogger({
    worker: "pipeline",
    requestId: message.requestId ?? fallbackRequestId(),
    practiceId: message.practiceId,
    stage: "classify",
  });
}

function log(event: string, message: ClassifyMessage, extra?: object): void {
  stageLogger(message).info(event, {
    signalId: message.signalId,
    importRunId: message.importRunId,
    ...extra,
  });
}

function warn(event: string, message: ClassifyMessage, extra?: object): void {
  stageLogger(message).warn(event, {
    signalId: message.signalId,
    importRunId: message.importRunId,
    ...extra,
  });
}

/**
 * The stage logic with its dependencies injected — what every test drives.
 * Throws per the dispatcher's failure vocabulary (see ./types.ts).
 */
export async function classifySignal(
  message: ClassifyMessage,
  env: PipelineBindings,
  deps: ClassifyDeps,
): Promise<void> {
  const signal = await deps.store.getSignal(message.signalId);
  if (!signal) {
    // The row is gone (or never existed): no retry can conjure it back.
    throw new NonRetryableError(
      `classify: signal ${message.signalId} does not exist`,
    );
  }

  // The issue-#75 seam: kill switch + budget, resolved once per message,
  // ahead of BOTH provider calls. There are deliberately no provider
  // checks anywhere else in this stage.
  const gate: ClassifyAiGate = deps.aiGate
    ? await deps.aiGate(message.practiceId)
    : { allow: true };

  if (signal.retentionState !== "active") {
    // Redacted/purged content is nulled by design (Epic #23) — there is
    // nothing left to judge, and inferring from the void would fabricate.
    log("pipeline.classify.skipped_retention", message, {
      retentionState: signal.retentionState,
    });
  } else if (!gate.allow) {
    // Deferred, not dropped (issue #75): the signal stays unclassified
    // with the re-drive marker set; the deterministic keyword fallback
    // keeps urgent routing sighted; route still runs below.
    await deferClassification(message, signal, deps, gate.reason);
  } else if (hasClassifiableText(signal.originalText)) {
    if (gate.softAlert) {
      // ≥ 80% of the monthly budget (issue #75 requirement 3): structured
      // warning only — no behavior change; the dashboard banner reads the
      // same state via `practiceAiStatus`.
      warn("pipeline.classify.ai_budget_soft_alert", message, gate.softAlert);
    }
    // Judgments first (issue #69 note): their output is needed for routing
    // even when the excerpt pass fails. Each pass has its own idempotency
    // probe, so a redelivery after judgments-but-no-excerpts re-runs only
    // the excerpt pass.
    await classifyWithModel(message, signal, deps);
    await extractExcerpts(message, signal, deps);
    await clearDeferralAfterRealPass(message, signal, deps);
  } else {
    const rating = Number(signal.originalRating);
    if (signal.originalRating !== null && Number.isFinite(rating)) {
      await classifyFromRating(message, rating, deps);
      await clearDeferralAfterRealPass(message, signal, deps);
    } else {
      // No text, no rating: nothing to judge. Route anyway — downstream
      // decides what an unjudged signal means.
      log("pipeline.classify.nothing_to_classify", message);
    }
  }

  await env.ROUTE_QUEUE.send({
    signalId: message.signalId,
    practiceId: message.practiceId,
    importRunId: message.importRunId,
    // Producers copy the trace id forward (issue #64).
    requestId: message.requestId,
  } satisfies RouteMessage);
}

/**
 * The deferral path (issue #75): mark the signal for later re-drive and
 * run the deterministic urgent-keyword fallback so the route stage can
 * still open recovery work — a patient in pain must not wait for the
 * budget month to roll over. No provider call happens on this path; the
 * one derivation it may write carries honest fallback provenance
 * (`keyword-fallback-v1`, confidence 0.3). Redacted/purged and
 * nothing-to-judge signals never reach here — they owe no classification.
 */
async function deferClassification(
  message: ClassifyMessage,
  signal: SignalForClassification,
  deps: ClassifyDeps,
  reason: "kill_switch" | "budget_exhausted",
): Promise<void> {
  const rating = Number(signal.originalRating);
  const wouldHaveJudged =
    hasClassifiableText(signal.originalText) ||
    (signal.originalRating !== null && Number.isFinite(rating));
  if (!wouldHaveJudged) {
    // Nothing to judge, gated or not — no classification is owed, so no
    // marker; same outcome as the ungated nothing-to-classify path.
    log("pipeline.classify.nothing_to_classify", message);
    return;
  }

  await deps.store.markClassificationDeferred(message.signalId);

  let keywordMatches: string[] = [];
  if (hasClassifiableText(signal.originalText) && signal.originalText) {
    keywordMatches = matchUrgentKeywords(signal.originalText);
    if (
      keywordMatches.length > 0 &&
      // Same idempotency posture as the model path: a redelivery must not
      // double-write the fallback row.
      !(await deps.store.hasJudgments(message.signalId, {
        modelVersion: URGENT_KEYWORD_MODEL_VERSION,
      }))
    ) {
      await deps.store.insertJudgments(message, [
        keywordUrgencyDerivation(keywordMatches),
      ]);
    }
  }

  // Loud by contract (issue #75 requirement 6): every deferral is logged
  // with its reason — an outage or cap must never degrade silently.
  warn("pipeline.classify.deferred", message, {
    reason,
    keywordUrgency: keywordMatches.length > 0,
    keywordMatches,
  });
}

/**
 * A real (non-deferred) pass just completed: clear the issue-#75 marker
 * if a previous delivery set it, so the re-drive sweep shrinks as the
 * backlog is worked off.
 */
async function clearDeferralAfterRealPass(
  message: ClassifyMessage,
  signal: SignalForClassification,
  deps: ClassifyDeps,
): Promise<void> {
  if (signal.classificationDeferredAt === null) return;
  await deps.store.clearClassificationDeferred(message.signalId);
  log("pipeline.classify.deferral_cleared", message, {
    deferredAt: signal.classificationDeferredAt.toISOString(),
  });
}

/** The one-Haiku-call path for signals with meaningful text. */
async function classifyWithModel(
  message: ClassifyMessage,
  signal: SignalForClassification,
  deps: ClassifyDeps,
): Promise<void> {
  if (
    await deps.store.hasJudgments(message.signalId, {
      modelVersion: deps.pipelineModel,
    })
  ) {
    log("pipeline.classify.already_classified", message, {
      modelVersion: deps.pipelineModel,
    });
    return;
  }

  if (!deps.provider) {
    throw new RetryableError(
      "classify: ANTHROPIC_API_KEY is not configured — cannot classify " +
        "signals with text. Set the secret (docs/secrets.md); dead-lettered " +
        "messages are replayable once it exists.",
    );
  }

  const result = await deps.provider.classify(
    judgmentsPrompt({
      text: signal.originalText,
      rating: signal.originalRating,
    }),
    JudgmentsSchema,
    {
      purpose: "judgments",
      practiceId: message.practiceId,
      model: "pipeline",
      requestId: message.requestId,
    },
  );

  // If the API served a different concrete id than the configured one
  // (e.g. PIPELINE_MODEL set to an alias), re-probe under the served id so
  // a redelivery can still never double-write.
  if (
    result.usage.model !== deps.pipelineModel &&
    (await deps.store.hasJudgments(message.signalId, {
      modelVersion: result.usage.model,
    }))
  ) {
    log("pipeline.classify.already_classified", message, {
      modelVersion: result.usage.model,
    });
    return;
  }

  const rows = judgmentsToDerivations(result.value, result.usage.model);
  await deps.store.insertJudgments(message, rows);
  log("pipeline.classify.classified", message, {
    modelVersion: result.usage.model,
    urgency: rows.find((row) => row.dimension === "urgency")?.value,
  });
}

/**
 * The excerpt pass (issue #69): split the signal's text into verbatim
 * aspect-level excerpts, write `proof_excerpts` rows, then embed them
 * inline (issue #71). Runs for every signal with classifiable text —
 * sentiment and publication suitability deliberately do NOT gate it
 * (Recovery/Coverage need aspect granularity for negative and private
 * signals too).
 */
async function extractExcerpts(
  message: ClassifyMessage,
  signal: SignalForClassification,
  deps: ClassifyDeps,
): Promise<void> {
  const text = signal.originalText;
  if (!text) return;

  if (await deps.store.hasExcerpts(message.signalId)) {
    log("pipeline.classify.excerpts_already_extracted", message);
    return;
  }

  let excerpts: readonly PlannedExcerpt[];
  if (countWords(text) < EXCERPT_MIN_MODEL_WORDS) {
    // Short-circuit (issue #69 requirement 1): under ~15 words the whole
    // text is already one quotable aspect — no model call.
    excerpts = [wholeTextExcerpt(text)];
  } else {
    if (!deps.provider) {
      // Same posture as the judgments pass: replayable once the key exists.
      throw new RetryableError(
        "classify: ANTHROPIC_API_KEY is not configured — cannot extract " +
          "excerpts from signals with text. Set the secret (docs/secrets.md); " +
          "dead-lettered messages are replayable once it exists.",
      );
    }
    excerpts = await extractExcerptsWithModel(message, text, deps.provider);
  }

  const stored = await deps.store.insertExcerpts(message, excerpts);
  log("pipeline.classify.excerpts_extracted", message, {
    count: stored.length,
  });

  await embedExcerptsInline(message, stored, deps);
}

/**
 * The model-selects-spans call with server-side verbatim enforcement
 * (issue #69 requirement 4): validate every returned excerpt against the
 * original text; on any violation retry ONCE with the rejections fed
 * back; still-invalid excerpts after the retry are skipped with a logged
 * warning — a fabricated quote is never stored. If nothing valid
 * survives, fall back to the whole text as one excerpt.
 */
async function extractExcerptsWithModel(
  message: ClassifyMessage,
  text: string,
  provider: AiProvider,
): Promise<PlannedExcerpt[]> {
  const opts = {
    purpose: "excerpts",
    practiceId: message.practiceId,
    model: "pipeline" as const,
    requestId: message.requestId,
  };

  const first = await provider.classify(
    excerptsPrompt({ text }),
    ExcerptsSchema,
    opts,
  );
  const firstPass = validateExcerpts(text, first.value);
  if (firstPass.rejected.length === 0) return firstPass.accepted;

  warn("pipeline.classify.excerpts_rejected_retrying", message, {
    rejectedCount: firstPass.rejected.length,
  });
  const second = await provider.classify(
    excerptsRetryPrompt({ text }, firstPass.rejected),
    ExcerptsSchema,
    opts,
  );
  const secondPass = validateExcerpts(text, second.value);
  if (secondPass.rejected.length > 0) {
    warn("pipeline.classify.excerpts_skipped_fabricated", message, {
      skippedCount: secondPass.rejected.length,
    });
  }

  // Prefer the retry's verified excerpts; fall back to the first pass's
  // (it may have had valid ones alongside the fabrications); last resort
  // is the whole text as one excerpt — never nothing, never fabrication.
  const best =
    secondPass.accepted.length > 0 ? secondPass.accepted : firstPass.accepted;
  if (best.length > 0) return best;

  warn("pipeline.classify.excerpts_whole_text_fallback", message);
  return [wholeTextExcerpt(text)];
}

/**
 * Inline embedding (issue #71 requirement 3). Failure must not fail the
 * message: log, leave the vectors NULL, and let the backfill Workflow
 * sweep them up — so this function never throws.
 */
async function embedExcerptsInline(
  message: ClassifyMessage,
  stored: readonly StoredExcerpt[],
  deps: ClassifyDeps,
): Promise<void> {
  if (stored.length === 0) return;
  const embedder = deps.embedder;
  if (!embedder) {
    warn("pipeline.classify.embedding_skipped_no_binding", message, {
      count: stored.length,
    });
    return;
  }
  try {
    const vectors = await embedder.embed(stored.map((row) => row.text));
    await deps.store.setExcerptEmbeddings(
      stored.flatMap((row, index) => {
        const embedding = vectors[index];
        return embedding
          ? [{ id: row.id, embedding, embeddingModel: embedder.model }]
          : [];
      }),
    );
    log("pipeline.classify.excerpts_embedded", message, {
      count: stored.length,
      embeddingModel: embedder.model,
    });
  } catch (error) {
    warn("pipeline.classify.embedding_failed", message, {
      count: stored.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The no-model-call path for rating-only signals (cost matters). */
async function classifyFromRating(
  message: ClassifyMessage,
  rating: number,
  deps: ClassifyDeps,
): Promise<void> {
  if (
    await deps.store.hasJudgments(message.signalId, {
      basis: "source_metadata",
    })
  ) {
    log("pipeline.classify.already_classified", message, {
      basis: "source_metadata",
    });
    return;
  }

  const rows = ratingOnlyDerivations(rating);
  await deps.store.insertJudgments(message, rows);
  log("pipeline.classify.classified_from_rating", message, { rating });
}

/** Production `ClassifyStore` over the Drizzle client. */
export function createClassifyStore(db: Db): ClassifyStore {
  return {
    getSignal: async (signalId) => {
      const row = await getSignal(db, signalId);
      if (!row) return undefined;
      return {
        originalText: row.originalText,
        originalRating: row.originalRating,
        retentionState: row.retentionState,
        classificationDeferredAt: row.classificationDeferredAt,
      };
    },
    hasJudgments: (signalId, source) =>
      signalHasDerivations(db, signalId, source),
    insertJudgments: async (message, rows) => {
      await insertDerivations(
        db,
        rows.map((row) => ({
          signalId: message.signalId,
          practiceId: message.practiceId,
          dimension: row.dimension as DerivationDimension,
          // jsonb scalar: the judgment value round-trips as a plain string.
          value: row.value,
          confidence: row.confidence,
          basis: row.basis,
          modelVersion: row.modelVersion,
          rationale: row.rationale,
        })),
      );
    },
    hasExcerpts: (signalId) => signalHasProofExcerpts(db, signalId),
    insertExcerpts: async (message, excerpts) => {
      const rows = await insertProofExcerpts(
        db,
        excerpts.map((excerpt) => ({
          signalId: message.signalId,
          practiceId: message.practiceId,
          excerptText: excerpt.text,
          startOffset: excerpt.startOffset,
          topicHint: excerpt.topicHint,
          // embedding stays NULL here; the inline pass (or the backfill
          // Workflow) fills it together with embedding_model.
        })),
      );
      return rows.map((row) => ({ id: row.id, text: row.excerptText }));
    },
    setExcerptEmbeddings: (updates) => setProofExcerptEmbeddings(db, updates),
    markClassificationDeferred: (signalId) =>
      markClassificationDeferred(db, signalId),
    clearClassificationDeferred: (signalId) =>
      clearClassificationDeferred(db, signalId),
  };
}

/**
 * The wired handler: per-message client over the Hyperdrive binding
 * (isolates cannot share sockets; Hyperdrive makes reconnects cheap), the
 * real `AnthropicProvider` with the `ai_calls` cost sink, config resolved
 * env → per-practice (issue #75: `practiceAiStatus` loads
 * `practice_settings.ai` + this month's spend once per message — one
 * indexed SUM, acceptable at M1 volume; the caching hook is documented on
 * `monthlyAiSpendCents`).
 */
export const classify: StageHandler<"classify"> = async (message, env) => {
  const cfg = getEnv(env, pipelineEnvSchema);
  if (!env.HYPERDRIVE) {
    // A topology bug, not a bad message — retry → DLQ keeps it replayable.
    throw new RetryableError(
      "classify: HYPERDRIVE binding is missing — the classify stage needs " +
        "Postgres (see workers/pipeline/wrangler.jsonc)",
    );
  }
  const { db, sql } = createDb(env.HYPERDRIVE.connectionString);
  try {
    // Env defaults → practice overrides (models, kill switch, budget).
    const status = await practiceAiStatus(db, {
      practiceId: message.practiceId,
      env: cfg,
    });
    const provider = cfg.ANTHROPIC_API_KEY
      ? new AnthropicProvider({
          apiKey: cfg.ANTHROPIC_API_KEY,
          models: status.config.models,
          logAiCall: createAiCallSink(db),
        })
      : undefined;
    const gate: ClassifyAiGate = status.config.disabled
      ? { allow: false, reason: "kill_switch" }
      : status.budget.level === "exhausted"
        ? { allow: false, reason: "budget_exhausted" }
        : {
            allow: true,
            softAlert:
              status.budget.level === "soft" &&
              status.config.monthlyBudgetCents !== null
                ? {
                    spentCents: status.spentCents,
                    budgetCents: status.config.monthlyBudgetCents,
                  }
                : undefined,
          };
    await classifySignal(message, env, {
      store: createClassifyStore(db),
      provider,
      // Workers AI binding for inline bge-m3 embeddings (issue #71).
      // Absent (e.g. local dev without the binding): excerpts keep a NULL
      // embedding and the backfill Workflow in workers/jobs sweeps them.
      embedder: env.AI ? createWorkersAiEmbedder(env.AI) : undefined,
      pipelineModel: status.config.models.pipeline,
      aiGate: async () => gate,
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
};
