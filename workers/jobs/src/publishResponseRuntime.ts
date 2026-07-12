/**
 * Real-bindings wiring for the publish-response consumer (issue #82): the
 * worker's `queue()` handler calls `handlePublishResponseBatch`; everything
 * decision-shaped lives in ./publishResponse.ts behind structural deps.
 *
 * Same conventions as gbpSyncRuntime.ts: one DB client per batch, closed in
 * `finally`; the #118 token provider with `persistNeedsReauth` as its
 * `onInvalidGrant` hook (durable BEFORE `NeedsReauthError` propagates);
 * `GOOGLE_MYBUSINESS_V4_BASE_URL` points the reply PUT at the fake GBP
 * server locally.
 */

import {
  createLogger,
  decryptField,
  extractRequestId,
  fallbackRequestId,
  type GoogleConnectionCredentials,
  getEnv,
  isPublishResponseQueue,
  jobsEnvSchema,
  keyringFromEnv,
  type Logger,
  logLevelFor,
  publishResponseMessageSchema,
} from "@wellregarded/core";
import {
  auditPublishAttempt,
  createDb,
  type Db,
  getResponse,
  getResponseReviewContext,
  getSourceConnection,
  transitionResponse,
} from "@wellregarded/db";
import {
  createGoogleAccessTokenProvider,
  publishReply,
} from "@wellregarded/sources";

import type { JobsBindings } from "./bindings";
import { persistNeedsReauth } from "./gbpSyncStore";
import {
  handlePublishResponseMessage,
  PUBLISH_RESPONSE_ACTOR,
  type PublishResponseDeps,
  type PublishResponseStore,
} from "./publishResponse";

/** Structural subset of a Queues `Message` (tests inject plain fakes). */
export interface PublishQueueMessageLike {
  readonly id: string;
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface PublishQueueBatchLike {
  readonly queue: string;
  readonly messages: readonly PublishQueueMessageLike[];
}

/** The real store: thin adapters over the packages/db helpers. */
export function createPublishResponseStore(db: Db): PublishResponseStore {
  return {
    getResponse: (practiceId, responseId) =>
      getResponse(db, practiceId, responseId),
    getReviewContext: (practiceId, signalId) =>
      getResponseReviewContext(db, practiceId, signalId),
    getGoogleConnection: (practiceId) =>
      getSourceConnection(db, practiceId, "google"),
    finalize: (input) =>
      transitionResponse(db, {
        practiceId: input.practiceId,
        responseId: input.responseId,
        to: input.to,
        actor: PUBLISH_RESPONSE_ACTOR,
        patch: input.patch,
        auditAction: input.auditAction,
        auditPayload: input.auditPayload,
        ...(input.markSignalDeletedAtSource
          ? { markSignalDeletedAtSource: true }
          : {}),
      }),
    auditAttempt: (input) =>
      auditPublishAttempt(db, { ...input, actor: PUBLISH_RESPONSE_ACTOR }),
  };
}

function requireBinding<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(
      `${name} binding is missing — the publish-response consumer cannot ` +
        "run. Check wrangler.jsonc (workers/jobs); bindings are NOT " +
        "inherited across envs.",
    );
  }
  return value;
}

function requireVar(value: string | undefined, name: string): string {
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is not configured — publishing replies needs the Google ` +
        "OAuth client. See docs/secrets.md.",
    );
  }
  return value;
}

/**
 * Consume one `wr-publish-response` batch against the real bindings.
 * Ack/retry semantics: workflow outcomes come back typed from the handler
 * (`ack` / `retry` with delay); malformed bodies ack with a loud log (the
 * same bytes will never parse — the queue's DLQ is for crash-shaped
 * failures, not schema ones); unknown errors retry (Queues honors
 * `max_retries`, then dead-letters).
 */
export async function handlePublishResponseBatch(
  batch: PublishQueueBatchLike,
  env: JobsBindings,
): Promise<void> {
  const vars = getEnv(env, jobsEnvSchema);
  const level = logLevelFor(vars.ENVIRONMENT);

  if (!isPublishResponseQueue(batch.queue)) {
    createLogger({
      worker: "jobs",
      requestId: fallbackRequestId(),
      stage: "publish-response",
      level,
    }).error("publish_response.unknown_queue", { queue: batch.queue });
    for (const message of batch.messages) message.retry();
    return;
  }

  const hyperdrive = requireBinding(env.HYPERDRIVE, "HYPERDRIVE");
  const keyring = keyringFromEnv({
    PII_ENCRYPTION_KEYS: requireVar(
      vars.PII_ENCRYPTION_KEYS,
      "PII_ENCRYPTION_KEYS",
    ),
    PII_HASH_KEY: requireVar(vars.PII_HASH_KEY, "PII_HASH_KEY"),
  });

  const { db, sql } = createDb(hyperdrive.connectionString);
  try {
    const tokenProvider = createGoogleAccessTokenProvider({
      config: {
        tokenUrl: vars.GOOGLE_OAUTH_TOKEN_URL,
        clientId: requireVar(vars.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID"),
        clientSecret: requireVar(
          vars.GOOGLE_CLIENT_SECRET,
          "GOOGLE_CLIENT_SECRET",
        ),
      },
      onInvalidGrant: (connectionId) => persistNeedsReauth(db, connectionId),
    });

    const store = createPublishResponseStore(db);
    const publish: PublishResponseDeps["publish"] = async (input) => {
      // encryptedCredentials is checked non-null by the handler before
      // calling publish; decrypt inside the call so the plaintext refresh
      // token never outlives it. NEVER-LOG(credentials).
      const credentials = JSON.parse(
        await decryptField(
          input.connection.encryptedCredentials ?? "",
          keyring,
        ),
      ) as GoogleConnectionCredentials;
      return publishReply(
        {
          getAccessToken: () =>
            tokenProvider.getAccessToken({
              id: input.connection.id,
              refreshToken: credentials.refreshToken,
            }),
          invalidateAccessToken: (id) => tokenProvider.invalidate(id),
          audit: input.audit,
          baseUrl: vars.GOOGLE_MYBUSINESS_V4_BASE_URL,
        },
        {
          connectionId: input.connection.id,
          reviewSourceId: input.reviewSourceId,
          text: input.text,
          actor: input.actor,
        },
      );
    };

    for (const message of batch.messages) {
      await consumeOne(message, { store, publish, level });
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function consumeOne(
  message: PublishQueueMessageLike,
  wiring: {
    store: PublishResponseStore;
    publish: PublishResponseDeps["publish"];
    level: Logger["level"];
  },
): Promise<void> {
  const parsed = publishResponseMessageSchema.safeParse(message.body);
  if (!parsed.success) {
    // Will never parse — retrying is pointless; log loudly and ack.
    createLogger({
      worker: "jobs",
      requestId: extractRequestId(message.body),
      stage: "publish-response",
      level: wiring.level,
    }).error("publish_response.malformed", {
      messageId: message.id,
      detail: parsed.error.message,
    });
    message.ack();
    return;
  }

  const log = createLogger({
    worker: "jobs",
    requestId: parsed.data.requestId ?? fallbackRequestId(),
    practiceId: parsed.data.practiceId,
    stage: "publish-response",
    level: wiring.level,
  });

  try {
    const outcome = await handlePublishResponseMessage(
      { store: wiring.store, publish: wiring.publish, log },
      parsed.data,
      message.attempts,
    );
    if (outcome.kind === "retry") {
      message.retry({ delaySeconds: outcome.delaySeconds });
    } else {
      message.ack();
    }
  } catch (error) {
    // Unknown failure (a bug or infra): retry — Queues honors max_retries,
    // then dead-letters to wr-publish-response-dlq.
    log.error("publish_response.unexpected_error", {
      messageId: message.id,
      error,
    });
    message.retry();
  }
}
