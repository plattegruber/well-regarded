/**
 * Normalize stage — consumer of `wr-ingest` (issue #104, Epic #6).
 *
 * Raw source payload → canonical `signals` rows:
 *
 * 1. Load the raw artifact from R2 (store-before-enqueue means a miss is a
 *    contract violation — non-retryable, straight to the DLQ).
 * 2. Resolve the `SourceAdapter` by `sourceKind` from the registry in
 *    `@wellregarded/sources` (unknown kind: non-retryable).
 * 3. `adapter.normalize(artifact)` → `NormalizedSignal[]`, re-validated
 *    against the strict schema (an invalid result is an adapter bug and the
 *    same bytes will never validate — non-retryable, recorded against the
 *    import run via the DLQ path).
 * 4. One DB transaction per artifact (`createNormalizeStore`): resolve
 *    provider/location hints against the practice's entities (exact-match
 *    only — see ./normalize/hints.ts), route patient hints through the PII
 *    seam in `packages/db`, insert `signals` rows idempotently
 *    (`ON CONFLICT DO NOTHING` on the `(practice_id, source_kind,
 *    source_id)` unique constraint), persist pre-existing source replies
 *    as imported `responses` rows (#214 — see `persistImportedReplies`),
 *    and update `import_runs` counts atomically with the inserts (#111
 *    helpers). A mid-artifact failure rolls the whole artifact back and
 *    retries — safe, because the inserts are idempotent by the unique
 *    constraint and the reply upsert by content comparison.
 * 5. AFTER the transaction commits, enqueue one `DedupeMessage` per signal:
 *    new rows plain, conflicting rows flagged `reason: "conflict_reimport"`
 *    (a potential update; #106 decides whether content changed). A crash
 *    between commit and enqueue is repaired by re-delivery of the ingest
 *    message: every row then conflicts and re-routes to dedupe — that is
 *    the designed recovery path, not an accident.
 *
 * Policy (hint matching, rating canonicalization) lives in pure functions
 * under ./normalize/ so it unit-tests without Miniflare; persistence lives
 * behind the `NormalizeStore` seam so workerd tests drive the real
 * dispatcher with an in-memory store (same pattern as classify, #67) and
 * the Node integration suite drives the real store against Postgres.
 */

import {
  createLogger,
  fallbackRequestId,
  getEnv,
  type IngestMessage,
  type Keyring,
  keyringFromEnv,
  NonRetryableError,
  pipelineEnvSchema,
  RetryableError,
} from "@wellregarded/core";
import {
  audit,
  createDb,
  type Db,
  grantConsent,
  incrementImportRunCounts,
  insertNormalizedSignals,
  matchOrCreatePatientByContact,
  type NormalizedSignalOutcome,
  type SignalInsert,
  schema,
  type Tx,
  upsertImportedResponse,
} from "@wellregarded/db";
import {
  ArtifactNotFoundError,
  getAdapter,
  getRawArtifact,
  type NormalizedSignal,
  normalizedSignalSchema,
} from "@wellregarded/sources";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { PipelineBindings } from "../bindings";
import { type NamedEntity, resolveEntityHint } from "./normalize/hints";
import { canonicalizeRating } from "./normalize/rating";
import type { StageHandler } from "./types";

/**
 * The stage's narrow persistence seam. Production is `createNormalizeStore`
 * over the Hyperdrive-backed client; workerd tests inject an in-memory
 * fake (no Postgres inside the test pool).
 */
export interface NormalizeStore {
  /**
   * The per-artifact transaction: hint resolution, idempotent inserts,
   * count updates — all-or-nothing. Returns one outcome per surviving
   * signal row.
   */
  persistSignals(
    message: IngestMessage,
    signals: NormalizedSignal[],
  ): Promise<NormalizedSignalOutcome[]>;
}

export interface NormalizeDeps {
  store: NormalizeStore;
}

function log(event: string, message: IngestMessage, extra?: object): void {
  // The dispatcher guarantees a requestId on delivered messages (issue
  // #64); the fallback only fires for direct test invocations.
  createLogger({
    worker: "pipeline",
    requestId: message.requestId ?? fallbackRequestId(),
    practiceId: message.practiceId,
    stage: "ingest",
  }).info(event, {
    importRunId: message.importRunId,
    rawArtifactKey: message.rawArtifactKey,
    sourceKind: message.sourceKind,
    ...extra,
  });
}

/**
 * The stage logic with its dependencies injected — what every test drives.
 * Throws per the dispatcher's failure vocabulary (see ./types.ts).
 */
export async function normalizeArtifact(
  message: IngestMessage,
  env: PipelineBindings,
  deps: NormalizeDeps,
): Promise<void> {
  const artifact = await loadArtifact(env, message.rawArtifactKey);

  const adapter = getAdapter(message.sourceKind);
  if (adapter === undefined) {
    throw new NonRetryableError(
      `normalize: no SourceAdapter registered for sourceKind "${message.sourceKind}"`,
    );
  }

  let normalized: unknown;
  try {
    normalized = await adapter.normalize(artifact);
  } catch (error) {
    // The artifact is immutable (content-addressed): if the adapter cannot
    // normalize these bytes now, it never will.
    throw new NonRetryableError(
      `normalize: adapter "${adapter.sourceKind}" failed on ${message.rawArtifactKey}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const parsed = z.array(normalizedSignalSchema).safeParse(normalized);
  if (!parsed.success) {
    throw new NonRetryableError(
      `normalize: adapter "${adapter.sourceKind}" violated the NormalizedSignal contract: ${z.prettifyError(parsed.error)}`,
    );
  }

  let outcomes: NormalizedSignalOutcome[];
  try {
    outcomes = await deps.store.persistSignals(message, parsed.data);
  } catch (error) {
    // Transaction failures are safe to retry: inserts are idempotent by the
    // unique constraint, and counts only commit with their rows.
    throw new RetryableError(
      `normalize: persistence failed for ${message.rawArtifactKey}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Post-commit enqueue (see module doc for the crash-recovery story).
  for (const outcome of outcomes) {
    await env.DEDUPE_QUEUE.send({
      signalId: outcome.signalId,
      practiceId: message.practiceId,
      importRunId: message.importRunId,
      // Producers MUST propagate the trace id (issue #64).
      requestId: message.requestId ?? fallbackRequestId(),
      ...(outcome.outcome === "conflict"
        ? { reason: "conflict_reimport" as const }
        : {}),
    });
  }

  log("pipeline.normalize.done", message, {
    created: outcomes.filter((o) => o.outcome === "created").length,
    conflicts: outcomes.filter((o) => o.outcome === "conflict").length,
  });
}

async function loadArtifact(
  env: PipelineBindings,
  rawArtifactKey: string,
): Promise<unknown> {
  try {
    return await getRawArtifact(env.RAW_ARTIFACTS, rawArtifactKey);
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) {
      // Store-before-enqueue (#100): an enqueued key always exists, so a
      // miss can never resolve by waiting — forward to the DLQ.
      throw new NonRetryableError(error.message);
    }
    // Anything else (R2 hiccup, JSON parse of a corrupted read) might be
    // transient — let the dispatcher retry it.
    throw error;
  }
}

/**
 * Production `NormalizeStore` over the Drizzle client: one transaction per
 * artifact (#104 requirement 7). `keyring` powers the PII seam; when the
 * isolate has none configured (the vars are optional until Epic #19/#20
 * makes them mandatory), patient hints are skipped with a structured log
 * line rather than failing the artifact.
 */
export function createNormalizeStore(
  db: Db,
  keyring: Keyring | undefined,
): NormalizeStore {
  return {
    persistSignals: (message, signals) =>
      db.transaction(async (tx) => {
        const entities = await loadPracticeEntities(tx, message.practiceId);

        const pairs: Array<{ signal: NormalizedSignal; row: SignalInsert }> =
          [];
        for (const signal of signals) {
          pairs.push({
            signal,
            row: await buildSignalRow(tx, message, signal, entities, keyring),
          });
        }

        const outcomes = await insertNormalizedSignals(
          tx,
          pairs.map((pair) => pair.row),
        );
        const created = outcomes.filter((o) => o.outcome === "created").length;
        const conflicts = outcomes.filter(
          (o) => o.outcome === "conflict",
        ).length;

        // Same transaction as the inserts (#104 requirement 6). Conflicts
        // are NOT "created" — they belong to the dedupe stage's
        // merged/skipped tally — so they only leave a trace in stats.
        await incrementImportRunCounts(
          tx,
          message.importRunId,
          { created },
          conflicts > 0 ? { normalize_conflicts: conflicts } : undefined,
        );

        await recordAttestedConsents(tx, message, pairs, outcomes);
        await persistImportedReplies(tx, message, pairs, outcomes);

        return outcomes;
      }),
  };
}

/**
 * The existing-reply seam (issue #214, Epic #10): a signal that arrived
 * with `sourceMetadata.existingReply` (the GBP adapter's pre-existing
 * owner-reply passthrough, #125) gets a `responses` row — `status =
 * 'published'`, `origin = 'source_import'`, no staff author — in the same
 * transaction as its insert, so response status, tier ordering, and
 * response-rate metrics see the reply the moment the review lands.
 *
 * Unlike the consent seam above, CONFLICT outcomes are processed too: a
 * re-poll delivers the review again, and the reply it carries may have
 * been edited (or its moderation verdict flipped) at Google since the
 * first ingest — `upsertImportedResponse` updates the imported row in
 * place, reports `unchanged` on a byte-identical re-poll (no write, no
 * audit), and the partial unique index makes duplicates structurally
 * impossible. Audit actor is `system pipeline:normalize`.
 */
async function persistImportedReplies(
  tx: Tx,
  message: IngestMessage,
  pairs: ReadonlyArray<{ signal: NormalizedSignal; row: SignalInsert }>,
  outcomes: readonly NormalizedSignalOutcome[],
): Promise<void> {
  const bySourceId = new Map(
    pairs
      .filter((pair) => pair.signal.sourceId !== null)
      .map((pair) => [pair.signal.sourceId as string, pair]),
  );
  for (const outcome of outcomes) {
    if (outcome.sourceId === null) continue;
    const reply = bySourceId.get(outcome.sourceId)?.signal.sourceMetadata
      ?.existingReply;
    if (reply === undefined) continue;
    await upsertImportedResponse(tx, {
      practiceId: message.practiceId,
      signalId: outcome.signalId,
      body: reply.comment,
      publishedAt:
        reply.updateTime !== undefined ? new Date(reply.updateTime) : null,
      publishUpdateTime: reply.updateTime ?? null,
      moderationState: reply.state ?? null,
      policyViolation: reply.policyViolation ?? null,
      actor: { type: "system", id: "pipeline:normalize" },
      auditPayload: { importRunId: message.importRunId },
    });
  }
}

/**
 * The consent seam (issue #138, Epic #8): a signal that arrived with a
 * `practice_attested` consent hint AND its attestation specifics
 * (`consentDetail`: channels, note, attester) gets a real `consents` row —
 * source `practice_attested` — in the same transaction as its insert, plus
 * the attestation's own audit entry.
 *
 * Deliberate boundaries:
 * - CREATED rows only. A conflict means the signal already exists and its
 *   consent (if any) was recorded when it was first created — re-granting
 *   on redelivery would stack duplicate versions.
 * - `consentDetail` is required, not just the hint: a bare hint (e.g. the
 *   CSV wizard's bulk attestation, whose channels were never captured)
 *   records nothing here — channels cannot be invented downstream. The
 *   CSV bulk-consent write is a separate Epic #12 seam.
 * - `imported_unknown` writes NOTHING: the absence of a `consents` row IS
 *   the state (the epic's structural rule).
 * - Attribution is pinned `anonymous` — the entry form does not ask how
 *   the patient may be identified, and the most conservative reading of an
 *   attestation is "the words may be used, the identity may not".
 *   Widening attribution is Epic #12's re-permission territory.
 */
async function recordAttestedConsents(
  tx: Tx,
  message: IngestMessage,
  pairs: ReadonlyArray<{ signal: NormalizedSignal; row: SignalInsert }>,
  outcomes: readonly NormalizedSignalOutcome[],
): Promise<void> {
  const bySourceId = new Map(
    pairs
      .filter((pair) => pair.signal.sourceId !== null)
      .map((pair) => [pair.signal.sourceId as string, pair]),
  );
  for (const outcome of outcomes) {
    if (outcome.outcome !== "created" || outcome.sourceId === null) continue;
    const pair = bySourceId.get(outcome.sourceId);
    if (
      pair === undefined ||
      pair.signal.consentHint !== "practice_attested" ||
      pair.signal.consentDetail === undefined
    ) {
      continue;
    }
    const detail = pair.signal.consentDetail;
    const consent = await grantConsent(tx, {
      practiceId: message.practiceId,
      signalId: outcome.signalId,
      patientId: pair.row.patientId ?? null,
      channels: detail.channels,
      attribution: "anonymous",
      grantedAt: new Date(detail.grantedAt),
      source: "practice_attested",
    });
    // The attestation's own audit entry (issue #138 requirement 5): the
    // actor is the staff member who attested; the note (where the
    // permission lives) rides the payload — `consents` has no note column.
    await audit(tx, {
      practiceId: message.practiceId,
      actor:
        detail.grantedBy !== undefined
          ? { type: "staff", id: detail.grantedBy }
          : { type: "system", id: "pipeline:normalize" },
      action: "consent.granted",
      entityType: "consents",
      entityId: consent.id,
      payload: {
        signalId: outcome.signalId,
        importRunId: message.importRunId,
        source: "practice_attested",
        channels: detail.channels,
        note: detail.note,
      },
    });
  }
}

interface PracticeEntities {
  providers: NamedEntity[];
  locations: NamedEntity[];
}

async function loadPracticeEntities(
  tx: Tx,
  practiceId: string,
): Promise<PracticeEntities> {
  const providerRows = await tx
    .select({
      id: schema.providers.id,
      displayName: schema.providers.displayName,
      fullName: schema.providers.fullName,
    })
    .from(schema.providers)
    .where(eq(schema.providers.practiceId, practiceId));
  const locationRows = await tx
    .select({ id: schema.locations.id, name: schema.locations.name })
    .from(schema.locations)
    .where(eq(schema.locations.practiceId, practiceId));
  return {
    providers: providerRows.map((row) => ({
      id: row.id,
      names: [row.displayName, row.fullName],
    })),
    locations: locationRows.map((row) => ({ id: row.id, names: [row.name] })),
  };
}

async function buildSignalRow(
  tx: Tx,
  message: IngestMessage,
  signal: NormalizedSignal,
  entities: PracticeEntities,
  keyring: Keyring | undefined,
): Promise<SignalInsert> {
  const provider = resolveEntityHint(signal.providerHint, entities.providers);
  const location = resolveEntityHint(signal.locationHint, entities.locations);
  const patientId = await resolvePatientHint(tx, message, signal, keyring);

  return {
    practiceId: message.practiceId,
    importRunId: message.importRunId,
    rawArtifactKey: message.rawArtifactKey,
    sourceKind: signal.sourceKind,
    sourceId: signal.sourceId,
    sourceUrl: signal.sourceUrl,
    occurredAt: new Date(signal.occurredAt),
    originalText: signal.originalText,
    originalRating: canonicalizeRating(signal.rating),
    visibility: signal.visibility,
    pipelineStatus: "pending_dedupe",
    providerId: provider.entityId,
    locationId: location.entityId,
    providerHint: provider.hint,
    locationHint: location.hint,
    patientId,
  };
}

/**
 * The PII seam (#104 requirement 4): a `patientHint` routes through the
 * `pii.patients` / `pii.contact_points` writer in `packages/db`
 * (create-or-match by contact point within the practice) — never inline PII
 * writes here.
 */
async function resolvePatientHint(
  tx: Tx,
  message: IngestMessage,
  signal: NormalizedSignal,
  keyring: Keyring | undefined,
): Promise<string | null> {
  if (signal.patientHint === undefined) return null;

  if (keyring === undefined) {
    createLogger({
      worker: "pipeline",
      requestId: message.requestId ?? fallbackRequestId(),
      practiceId: message.practiceId,
      stage: "ingest",
    }).warn("pipeline.normalize.patient_hint_skipped", {
      reason: "PII keyring not configured (PII_ENCRYPTION_KEYS/PII_HASH_KEY)",
      importRunId: message.importRunId,
      sourceId: signal.sourceId,
    });
    return null;
  }
  return matchOrCreatePatientByContact(tx, {
    practiceId: message.practiceId,
    hint: signal.patientHint,
    keyring,
  });
}

/**
 * The wired handler: per-message client over the Hyperdrive binding
 * (isolates cannot share sockets; Hyperdrive makes reconnects cheap), the
 * PII keyring from validated env when configured.
 */
export const normalize: StageHandler<"ingest"> = async (message, env) => {
  const cfg = getEnv(env, pipelineEnvSchema);
  if (!env.HYPERDRIVE) {
    // A topology bug, not a bad message — retry → DLQ keeps it replayable.
    throw new RetryableError(
      "normalize: HYPERDRIVE binding is missing — the normalize stage needs " +
        "Postgres (see workers/pipeline/wrangler.jsonc)",
    );
  }
  const keyring =
    cfg.PII_ENCRYPTION_KEYS && cfg.PII_HASH_KEY
      ? keyringFromEnv({
          PII_ENCRYPTION_KEYS: cfg.PII_ENCRYPTION_KEYS,
          PII_HASH_KEY: cfg.PII_HASH_KEY,
        })
      : undefined;
  const { db, sql } = createDb(env.HYPERDRIVE.connectionString);
  try {
    await normalizeArtifact(message, env, {
      store: createNormalizeStore(db, keyring),
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
};
