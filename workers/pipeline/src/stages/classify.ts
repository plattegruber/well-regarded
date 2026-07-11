/**
 * Classify stage — consumer of `wr-classify` (issue #67, Epic #9).
 *
 * One Haiku-lane call per signal returns all four judgments (sentiment,
 * urgency, response risk, publication suitability); each becomes a
 * `derivations` row with confidence, rationale, basis `inferred_text`, and
 * the concrete `model_version` from the AI result. The consumer stays thin
 * — fetch signal → call provider → insert rows → enqueue route — with the
 * judgment-shaped logic (prompt, schema, urgency floor, deterministic
 * fallbacks) in `@wellregarded/ai` (src/prompts/judgments.ts).
 *
 * Paths per signal (see `classifySignal`):
 * - **Text** (≥ 3 words): one `provider.classify` call → four rows.
 *   Low-confidence urgency (< 0.5) is floored UP one level
 *   (`applyUrgencyFloor`) — a missed urgent complaint is a patient walking
 *   away in pain; a false alarm costs a human ten seconds.
 * - **Rating only** (empty/short text, has a rating): NO model call —
 *   deterministic rows via `ratingOnlyDerivations`, basis
 *   `source_metadata`. Cost matters: a 2,000-review CSV backfill should
 *   not spend 2,000 calls on bare star ratings.
 * - **Neither**: nothing to judge; log and move on.
 * Every path ends by enqueueing a RouteMessage — routing decides what the
 * derivations (or their absence) mean.
 *
 * Idempotency: Queues deliver at-least-once, so before calling the model
 * we probe for existing derivations from this model version (the
 * deterministic path probes basis `source_metadata`) and skip the write on
 * redelivery. The route enqueue is deliberately NOT deduplicated — the
 * route stage must be idempotent anyway, and a duplicate RouteMessage is
 * harmless where a missing one is not.
 *
 * Cost/backpressure: ~1 Haiku call per text signal. The queue's
 * `max_batch_size`/`max_retries` (wrangler.jsonc) drain a big import
 * gradually, and `AnthropicProvider`'s 429 backoff (#63) absorbs bursts —
 * this handler adds no throttling of its own. Cost accounting rides the
 * injected `AiCallSink` (purpose `"judgments"`, billed to the signal's
 * practice).
 */

import {
  type AiProvider,
  AnthropicProvider,
  hasClassifiableText,
  type JudgmentDerivation,
  JudgmentsSchema,
  judgmentsPrompt,
  judgmentsToDerivations,
  ratingOnlyDerivations,
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
  createAiCallSink,
  createDb,
  type Db,
  type DerivationDimension,
  getSignal,
  insertDerivations,
  signalHasDerivations,
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
}

/** Where existing judgments came from — the idempotency probe's key. */
export type JudgmentSource =
  | { modelVersion: string }
  | { basis: "source_metadata" };

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
}

export interface ClassifyDeps {
  store: ClassifyStore;
  /**
   * Absent when `ANTHROPIC_API_KEY` is not configured: the deterministic
   * rating-only path still works; text signals throw `RetryableError` with
   * an actionable message (retry → DLQ, replayable once the key is set).
   */
  provider?: AiProvider | undefined;
  /**
   * Concrete pipeline-lane model id (`PIPELINE_MODEL`) — the idempotency
   * probe's model_version. Pin dated ids (the env default is one) so this
   * matches what the API reports back in `usage.model`.
   */
  pipelineModel: string;
}

function log(event: string, message: ClassifyMessage, extra?: object): void {
  // The dispatcher guarantees a requestId on delivered messages (issue
  // #64); the fallback only fires for direct test invocations.
  createLogger({
    worker: "pipeline",
    requestId: message.requestId ?? fallbackRequestId(),
    practiceId: message.practiceId,
    stage: "classify",
  }).info(event, {
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
  // TODO(#75): the AI kill switch lands here — when the operator flips it
  // (env config, e.g. AI_DISABLED), skip straight to the route enqueue
  // without touching the provider, so the spine keeps flowing and signals
  // can be reclassified once it is re-enabled. This is the ONE seam #75
  // needs; do not add provider checks elsewhere.

  const signal = await deps.store.getSignal(message.signalId);
  if (!signal) {
    // The row is gone (or never existed): no retry can conjure it back.
    throw new NonRetryableError(
      `classify: signal ${message.signalId} does not exist`,
    );
  }

  if (signal.retentionState !== "active") {
    // Redacted/purged content is nulled by design (Epic #23) — there is
    // nothing left to judge, and inferring from the void would fabricate.
    log("pipeline.classify.skipped_retention", message, {
      retentionState: signal.retentionState,
    });
  } else if (hasClassifiableText(signal.originalText)) {
    await classifyWithModel(message, signal, deps);
  } else {
    const rating = Number(signal.originalRating);
    if (signal.originalRating !== null && Number.isFinite(rating)) {
      await classifyFromRating(message, rating, deps);
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
    getSignal: (signalId) => getSignal(db, signalId),
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
  };
}

/**
 * The wired handler: per-message client over the Hyperdrive binding
 * (isolates cannot share sockets; Hyperdrive makes reconnects cheap), the
 * real `AnthropicProvider` with the `ai_calls` cost sink, config from
 * validated env.
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
    const provider = cfg.ANTHROPIC_API_KEY
      ? new AnthropicProvider({
          apiKey: cfg.ANTHROPIC_API_KEY,
          models: {
            pipeline: cfg.PIPELINE_MODEL,
            drafting: cfg.DRAFTING_MODEL,
          },
          logAiCall: createAiCallSink(db),
        })
      : undefined;
    await classifySignal(message, env, {
      store: createClassifyStore(db),
      provider,
      pipelineModel: cfg.PIPELINE_MODEL,
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
};
