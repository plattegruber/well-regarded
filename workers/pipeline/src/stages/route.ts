/**
 * Route stage — consumer of `wr-route`, the pipeline's terminal hop
 * (issue #108, Epic #6).
 *
 * Reads the signal plus its CURRENT derivations (latest generation per
 * dimension, manual outranking inferred — `getCurrentDerivations` in
 * `@wellregarded/db` owns that resolution) and fans out to the product
 * surfaces. Branches are independent — a public, urgent, publishable
 * signal takes all three:
 *
 * - **Urgency → recovery** (`RecoverySink` seam): urgency at/above the
 *   practice's routing threshold (default `high`). The `recovery_items`
 *   table is Epic #15 (M2) and does not exist yet, so the only current
 *   sink logs a warning and audits `signal.routed_urgent` — nothing is
 *   silently dropped, and #122 can replay the audit trail when the real
 *   sink lands. See the TODO(#122) contract on {@link RecoverySink}.
 * - **Public review → inbox**: `visibility = 'public'`. Reviews are
 *   signals — "entering the inbox" is a state of the signal, not a copied
 *   row. Epic #10's inbox query (#76) selects on `visibility = 'public'`
 *   joined to `responses`/`derivations` — there is deliberately NO
 *   inbox-state column on `signals` (#76: "not a status column on
 *   signals"). So the inbox-facing state this stage sets is the terminal
 *   `pipeline_status: 'processed'` plus a `signal.entered_review_inbox`
 *   audit entry (which carries the entry timestamp #108 wanted from
 *   `inbox_entered_at`). If #76 later needs a dedicated column, it lands
 *   there with a backfill from these audit rows.
 * - **Proof candidate** (`ProofSink` seam): positive sentiment + specific
 *   text + suitable-for-publication with adequate confidence. The
 *   `proofs` table is Epic #13 (M2); the only current sink audits
 *   `signal.proof_candidate`. See the TODO(#96) contract on
 *   {@link ProofSink}. This is a suggestion only — consent gating is the
 *   proof library's job; nothing here touches `consents`.
 * - **Quiet path**: none of the above — the signal simply rests in the
 *   signals store (still queryable in the unified inbox, Epic #11), with
 *   a `signal.routed` audit entry.
 *
 * Every path advances `pipeline_status` to the terminal `processed` and
 * updates the import run's per-branch stats counters. All writes for one
 * message commit in ONE transaction (`RouteStore.commitRouting`);
 * branch handlers and sinks QUEUE audit entries / counters into the
 * outcome rather than writing directly, so a mid-message crash leaves no
 * partial trail. Idempotency rides `pipeline_status`: a re-delivered
 * message finds `processed` and skips, so audits never double-write.
 *
 * Missing derivations where classify should have written them (the
 * signal has classifiable text or a rating, and is not redacted/purged)
 * is a contract violation, not a transient — NonRetryableError → DLQ,
 * visible on the import run. Signals with nothing to judge (no text, no
 * rating, or redacted) legitimately arrive derivation-less and take the
 * quiet path: never route on absent data, but never dead-letter a signal
 * that was always going to be unjudged.
 */

import { hasClassifiableText } from "@wellregarded/ai";
import {
  createLogger,
  DEFAULT_URGENCY_ROUTING_THRESHOLD,
  DERIVATION_DIMENSIONS,
  type DerivationBasis,
  type DerivationDimension,
  fallbackRequestId,
  isUrgencyLevel,
  type Logger,
  meetsUrgencyThreshold,
  NonRetryableError,
  type RetentionState,
  RetryableError,
  type RouteMessage,
  type SignalPipelineStatus,
  type SignalVisibility,
  type UrgencyLevel,
} from "@wellregarded/core";
import {
  audit,
  createDb,
  type Db,
  getCurrentDerivations,
  getSignal,
  incrementImportRunCounts,
  schema,
} from "@wellregarded/db";
import { eq } from "drizzle-orm";

import type { StageHandler } from "./types";

/** What the stage reads off a `signals` row. */
export interface SignalForRouting {
  visibility: SignalVisibility;
  originalText: string | null;
  /** numeric(2,1) arrives from postgres-js as a string, e.g. `"4.0"`. */
  originalRating: string | null;
  retentionState: RetentionState;
  /** `processed` = already routed — the idempotency key (see module doc). */
  pipelineStatus: SignalPipelineStatus;
}

/**
 * The current judgment for one dimension, as routing consumes it.
 * `value` stays `unknown` (jsonb scalar) — `decideRoutes` narrows it
 * against the `@wellregarded/core` vocabularies and treats anything
 * unrecognized as absent.
 */
export interface RoutingJudgment {
  value: unknown;
  confidence: number;
  basis: DerivationBasis;
}

/** Current derivations per dimension; `undefined` where none exists. */
export type RoutingDerivations = Record<
  DerivationDimension,
  RoutingJudgment | undefined
>;

/**
 * Per-practice routing configuration (issue #108 requirement 2).
 *
 * `practices` has no settings storage yet, so production wires
 * {@link defaultRoutingConfig}; the injected-config shape IS the seam.
 * When practice settings land (#122 proposes a settings jsonb on
 * `practices` for recovery due-windows — the routing threshold belongs in
 * the same mechanism), the wired handler loads this per practice and
 * nothing else changes.
 */
export interface RoutingConfig {
  /** Urgency at/above this opens recovery work. Default `high`. */
  urgencyThreshold: UrgencyLevel;
}

export const defaultRoutingConfig: RoutingConfig = {
  urgencyThreshold: DEFAULT_URGENCY_ROUTING_THRESHOLD,
};

/**
 * Proof-candidate text-specificity heuristic (issue #108 requirement 4):
 * a testimonial-worthy signal must have enough of the patient's own words
 * to excerpt from. Deliberately minimal — real "specificity" refinement
 * is classification work (Epic #9); this only filters out bare
 * star-ratings and one-liners like "Great!".
 */
export const MIN_PROOF_TEXT_LENGTH = 40;

/** Minimum confidence on a `suitable` publication-suitability judgment. */
export const MIN_SUITABILITY_CONFIDENCE = 0.7;

/** Non-empty original text above the minimal length, whitespace-trimmed. */
export function isSpecificText(text: string | null): boolean {
  return text !== null && text.trim().length >= MIN_PROOF_TEXT_LENGTH;
}

/** One product-surface outcome the route stage decided to take. */
export type RouteDecision =
  | { kind: "recovery"; urgency: UrgencyLevel; confidence: number }
  | { kind: "review_inbox" }
  | { kind: "proof_candidate"; suitabilityConfidence: number };

/**
 * The routing policy, pure (issue #108 requirement: handlers execute
 * decisions; this decides them). Empty result = the quiet path.
 */
export function decideRoutes(
  signal: SignalForRouting,
  derivations: RoutingDerivations,
  config: RoutingConfig,
): RouteDecision[] {
  const decisions: RouteDecision[] = [];

  const urgency = derivations.urgency;
  if (
    urgency !== undefined &&
    isUrgencyLevel(urgency.value) &&
    meetsUrgencyThreshold(urgency.value, config.urgencyThreshold)
  ) {
    decisions.push({
      kind: "recovery",
      urgency: urgency.value,
      confidence: urgency.confidence,
    });
  }

  if (signal.visibility === "public") {
    decisions.push({ kind: "review_inbox" });
  }

  const sentiment = derivations.sentiment;
  const suitability = derivations.publication_suitability;
  if (
    sentiment?.value === "positive" &&
    isSpecificText(signal.originalText) &&
    suitability !== undefined &&
    suitability.value === "suitable" &&
    suitability.confidence >= MIN_SUITABILITY_CONFIDENCE
  ) {
    decisions.push({
      kind: "proof_candidate",
      suitabilityConfidence: suitability.confidence,
    });
  }

  return decisions;
}

/**
 * Should classify have written derivations for this signal? Mirrors the
 * classify stage's own dispatch (#67): text with ≥ 3 words gets the model
 * path, a parseable rating gets deterministic rows, redacted/purged
 * content is skipped. When this is true and no derivations exist, classify
 * broke its contract — DLQ, never route on absent data (#108 req 7).
 */
export function classifyShouldHaveJudged(signal: SignalForRouting): boolean {
  if (signal.retentionState !== "active") return false;
  if (hasClassifiableText(signal.originalText)) return true;
  return (
    signal.originalRating !== null &&
    Number.isFinite(Number(signal.originalRating))
  );
}

/** An audit entry queued into the routing transaction. */
export interface RouteAuditSpec {
  /** Dot-namespaced `entity.verb`, e.g. `signal.routed_urgent`. */
  action: string;
  /** References and non-PII fields only — never signal text. */
  payload?: Record<string, unknown>;
}

/**
 * Everything one message writes, committed atomically by
 * `RouteStore.commitRouting`: audit entries (all `entity_type: signals`,
 * `entity_id: signalId`, actor `system` / `pipeline:route`) and
 * import-run stats counter deltas.
 */
export interface RoutingOutcome {
  audits: RouteAuditSpec[];
  stats: Record<string, number>;
}

/** What a sink gets: the message, a bound logger, the derivations it may
 * cite in payloads, and the queue-into-the-transaction writers. */
export interface RouteSinkContext {
  message: RouteMessage;
  log: Logger;
  derivations: RoutingDerivations;
  /** Queue an audit entry; committed with the routing transaction. */
  audit(spec: RouteAuditSpec): void;
  /** Bump a per-branch counter in the import run's stats jsonb. */
  count(stat: string, n?: number): void;
}

/**
 * Seam for the urgency → recovery branch (issue #108 requirement 2).
 *
 * TODO(#122): the `recovery_items` table (Epic #15, M2) does not exist
 * yet; {@link auditOnlyRecoverySink} is the only implementation. The real
 * sink #122 plugs in here must:
 *
 * - Create ONE `recovery_items` row: `signal_id`, practice-scoped,
 *   `status: 'open'`, `severity` mapped from `urgency` (`critical` →
 *   `urgent`, `high` → `high`, below-threshold values a practice config
 *   admits → `normal`), `due_at` from #122's per-severity windows.
 * - **Dedupe rule (#108):** never create a second item while a non-closed
 *   item exists for the same `signal_id` — enforced at the database with
 *   a partial unique index on `(signal_id)` WHERE status is non-terminal
 *   (#122's terminal states: `resolved`, `closed_no_action`), inserted
 *   with `ON CONFLICT DO NOTHING` so queue re-delivery is harmless.
 * - Audit `recovery_item.created` (entity `recovery_items`, the new row's
 *   id) via `context.audit` INSTEAD of `signal.routed_urgent`, and count
 *   the same `route_urgent` stat.
 * - Join the routing transaction: the row insert must commit atomically
 *   with the audit + status advance — extend `RoutingOutcome` with a
 *   typed effect the store executes (or hand the sink the `Tx`); do not
 *   write through a second connection.
 * - Backfill note: `signal.routed_urgent` audit rows written by the
 *   interim sink are the replay set for items that predate #122.
 */
export interface RecoverySink {
  openRecoveryItem(
    signal: SignalForRouting,
    urgency: UrgencyLevel,
    context: RouteSinkContext,
  ): Promise<void>;
}

/**
 * The interim recovery sink: logs (warn — an urgent signal currently gets
 * no tracked follow-up) and audits `signal.routed_urgent`, so the urgent
 * branch is never silently dropped while `recovery_items` is unbuilt.
 */
export const auditOnlyRecoverySink: RecoverySink = {
  openRecoveryItem: async (_signal, urgency, context) => {
    context.log.warn("pipeline.route.urgent_unactioned", {
      signalId: context.message.signalId,
      importRunId: context.message.importRunId,
      urgency,
      reason: "recovery_items does not exist yet (Epic #15, #122)",
    });
    context.audit({
      action: "signal.routed_urgent",
      payload: {
        urgency,
        confidence: context.derivations.urgency?.confidence,
        basis: context.derivations.urgency?.basis,
        importRunId: context.message.importRunId,
      },
    });
    context.count("route_urgent");
  },
};

/**
 * Seam for the proof-candidate branch (issue #108 requirement 4).
 *
 * TODO(#96): the `proofs` table (Epic #13, M2) does not exist yet;
 * {@link auditOnlyProofSink} is the only implementation. The real sink
 * #96 plugs in here must:
 *
 * - Create a `proofs` row `{ signal_id, practice_id, status:
 *   'suggested', excerpt_id: null }` — a whole-signal suggestion; excerpt
 *   extraction and `display_text` initialization are Epic #13's job.
 * - Be idempotent per signal: skip creation when any non-archived proof
 *   already exists for the `signal_id` (re-delivery and re-classification
 *   must not stack suggestions).
 * - Audit `proof.suggested` (entity `proofs`, the new row's id) via
 *   `context.audit` INSTEAD of `signal.proof_candidate`, and count the
 *   same `route_proof_candidate` stat.
 * - Join the routing transaction (same rule as {@link RecoverySink}).
 * - This creates a suggestion ONLY: consent-gated visibility lives in
 *   #96's `publishableProofs` query joins — nothing routes through
 *   `consents` here.
 */
export interface ProofSink {
  suggestProof(
    signal: SignalForRouting,
    context: RouteSinkContext,
  ): Promise<void>;
}

/** The interim proof sink: logs and audits `signal.proof_candidate`. */
export const auditOnlyProofSink: ProofSink = {
  suggestProof: async (_signal, context) => {
    context.log.info("pipeline.route.proof_candidate", {
      signalId: context.message.signalId,
      importRunId: context.message.importRunId,
    });
    context.audit({
      action: "signal.proof_candidate",
      payload: {
        sentiment: context.derivations.sentiment?.value,
        suitabilityConfidence:
          context.derivations.publication_suitability?.confidence,
        importRunId: context.message.importRunId,
      },
    });
    context.count("route_proof_candidate");
  },
};

/**
 * The stage's narrow persistence seam. Production is `createRouteStore`
 * over the Hyperdrive-backed client; workerd tests inject an in-memory
 * fake (no Postgres inside the test pool).
 */
export interface RouteStore {
  getSignal(signalId: string): Promise<SignalForRouting | undefined>;
  /** CURRENT derivations: latest per dimension, manual outranks inferred. */
  getCurrentDerivations(signalId: string): Promise<RoutingDerivations>;
  /**
   * ONE transaction: insert the outcome's audit rows, advance the
   * signal's `pipeline_status` to `processed`, and accumulate the
   * outcome's import-run stats counters.
   */
  commitRouting(message: RouteMessage, outcome: RoutingOutcome): Promise<void>;
}

export interface RouteDeps {
  store: RouteStore;
  recovery: RecoverySink;
  proof: ProofSink;
  config: RoutingConfig;
}

function makeLog(message: RouteMessage): Logger {
  // The dispatcher guarantees a requestId on delivered messages (issue
  // #64); the fallback only fires for direct test invocations.
  return createLogger({
    worker: "pipeline",
    requestId: message.requestId ?? fallbackRequestId(),
    practiceId: message.practiceId,
    stage: "route",
  });
}

/**
 * The stage logic with its dependencies injected — what every test drives.
 * Throws per the dispatcher's failure vocabulary (see ./types.ts).
 */
export async function routeSignal(
  message: RouteMessage,
  deps: RouteDeps,
): Promise<void> {
  const log = makeLog(message);

  const signal = await deps.store.getSignal(message.signalId);
  if (!signal) {
    // The row is gone (or never existed): no retry can conjure it back.
    throw new NonRetryableError(
      `route: signal ${message.signalId} does not exist`,
    );
  }

  if (signal.pipelineStatus === "processed") {
    // Re-delivery after a full commit (queues are at-least-once): the
    // terminal status is the idempotency key — skip, so audit entries and
    // stats counters never double-write (#108 implementation note).
    log.info("pipeline.route.already_routed", {
      signalId: message.signalId,
      importRunId: message.importRunId,
    });
    return;
  }

  const derivations = await deps.store.getCurrentDerivations(message.signalId);
  const hasDerivations = DERIVATION_DIMENSIONS.some(
    (dimension) => derivations[dimension] !== undefined,
  );
  if (!hasDerivations && classifyShouldHaveJudged(signal)) {
    // Classify's contract violation, not a transient: the same message
    // would find the same absence forever. DLQ keeps it replayable once
    // the signal is (re)classified, and visible on the import run.
    throw new NonRetryableError(
      `route: signal ${message.signalId} has classifiable content but no ` +
        "derivations — classify never judged it; never route on absent data",
    );
  }

  const decisions = decideRoutes(signal, derivations, deps.config);

  const outcome: RoutingOutcome = { audits: [], stats: {} };
  const context: RouteSinkContext = {
    message,
    log,
    derivations,
    audit: (spec) => outcome.audits.push(spec),
    count: (stat, n = 1) => {
      outcome.stats[stat] = (outcome.stats[stat] ?? 0) + n;
    },
  };

  for (const decision of decisions) {
    switch (decision.kind) {
      case "recovery":
        await deps.recovery.openRecoveryItem(signal, decision.urgency, context);
        break;
      case "review_inbox":
        // Inbox-facing state = visibility (already `public`) + the
        // terminal `processed` status committed below; this audit entry
        // carries the entry timestamp (see module doc for the #76
        // reconciliation).
        context.audit({
          action: "signal.entered_review_inbox",
          payload: { importRunId: message.importRunId },
        });
        context.count("route_review_inbox");
        break;
      case "proof_candidate":
        await deps.proof.suggestProof(signal, context);
        break;
    }
  }

  if (decisions.length === 0) {
    // The quiet path is a real outcome, audited like the rest (#108
    // requirement 6): the signal rests in the signals store, queryable in
    // the unified inbox (Epic #11).
    context.audit({
      action: "signal.routed",
      payload: { outcome: "no_action", importRunId: message.importRunId },
    });
    context.count("route_quiet");
  }

  try {
    await deps.store.commitRouting(message, outcome);
  } catch (error) {
    // Safe to retry: nothing committed (single transaction), and a
    // successful earlier delivery is caught by the `processed` skip.
    throw new RetryableError(
      `route: routing commit failed for signal ${message.signalId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  log.info("pipeline.route.done", {
    signalId: message.signalId,
    importRunId: message.importRunId,
    branches: decisions.map((decision) => decision.kind),
  });
}

/** Every routing audit row is written by this actor (issue #46 vocab). */
const ROUTE_ACTOR = { type: "system", id: "pipeline:route" } as const;

/** Production `RouteStore` over the Drizzle client. */
export function createRouteStore(db: Db): RouteStore {
  return {
    getSignal: async (signalId) => {
      const row = await getSignal(db, signalId);
      if (!row) return undefined;
      return {
        visibility: row.visibility,
        originalText: row.originalText,
        originalRating: row.originalRating,
        retentionState: row.retentionState,
        pipelineStatus: row.pipelineStatus,
      };
    },
    getCurrentDerivations: async (signalId) => {
      const current = await getCurrentDerivations(db, signalId);
      return Object.fromEntries(
        DERIVATION_DIMENSIONS.map((dimension) => {
          const row = current[dimension];
          return [
            dimension,
            row === undefined
              ? undefined
              : {
                  value: row.value,
                  confidence: row.confidence,
                  basis: row.basis,
                },
          ];
        }),
      ) as RoutingDerivations;
    },
    commitRouting: (message, outcome) =>
      db.transaction(async (tx) => {
        for (const spec of outcome.audits) {
          await audit(tx, {
            practiceId: message.practiceId,
            actor: ROUTE_ACTOR,
            action: spec.action,
            entityType: "signals",
            entityId: message.signalId,
            ...(spec.payload ? { payload: spec.payload } : {}),
          });
        }
        await tx
          .update(schema.signals)
          .set({ pipelineStatus: "processed", updatedAt: new Date() })
          .where(eq(schema.signals.id, message.signalId));
        // Same transaction as the writes it describes (#111 requirement).
        await incrementImportRunCounts(
          tx,
          message.importRunId,
          {},
          outcome.stats,
        );
      }),
  };
}

/**
 * The wired handler: per-message client over the Hyperdrive binding
 * (isolates cannot share sockets; Hyperdrive makes reconnects cheap), the
 * interim audit-only sinks, and the default routing config (per-practice
 * settings are a seam — see {@link RoutingConfig}).
 */
export const route: StageHandler<"route"> = async (message, env) => {
  if (!env.HYPERDRIVE) {
    // A topology bug, not a bad message — retry → DLQ keeps it replayable.
    throw new RetryableError(
      "route: HYPERDRIVE binding is missing — the route stage needs " +
        "Postgres (see workers/pipeline/wrangler.jsonc)",
    );
  }
  const { db, sql } = createDb(env.HYPERDRIVE.connectionString);
  try {
    await routeSignal(message, {
      store: createRouteStore(db),
      recovery: auditOnlyRecoverySink,
      proof: auditOnlyProofSink,
      config: defaultRoutingConfig,
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
};
