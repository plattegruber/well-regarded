/**
 * Shared plumbing for the pipeline worker's Node integration tests: a
 * `PipelineBindings` fake wired to the harness database, an in-memory R2
 * bucket, and recording queue producers — plus fake queue messages for
 * driving `handleQueueBatch` directly (dispatch.ts is typed structurally
 * for exactly this).
 */

import { vi } from "vitest";

import {
  requireDatabaseUrl,
  withDatabase,
} from "../../../../packages/db/test/support.js";
import type { PipelineBindings, QueueProducer } from "../../src/bindings";
import type { QueueMessageLike } from "../../src/dispatch";

/**
 * Test-only PII keyring material — the same committed values as
 * `TEST_KEYRING` in packages/db/test/factories.ts, in env-var form so the
 * wired normalize handler builds its keyring exactly as production does.
 */
export const TEST_PII_ENV = {
  PII_ENCRYPTION_KEYS: '{"1":"3l4Zg1nkiYyIDvi2rL9BW6BpAgLE0za88AGB98s8xIo="}',
  PII_HASH_KEY: "H0M2t0Cyp0kWt3pWn4E2G9dY0aQx8bH4bBqkYb7t0eE=",
} as const;

export interface RecordingProducer extends QueueProducer {
  sent: unknown[];
}

export function recordingProducer(): RecordingProducer {
  const sent: unknown[] = [];
  return {
    sent,
    send: async (body: unknown) => {
      sent.push(body);
    },
  };
}

export interface IntegrationEnv extends PipelineBindings {
  DEDUPE_QUEUE: RecordingProducer;
  CLASSIFY_QUEUE: RecordingProducer;
  ROUTE_QUEUE: RecordingProducer;
  INGEST_DLQ: RecordingProducer;
  DEDUPE_DLQ: RecordingProducer;
  CLASSIFY_DLQ: RecordingProducer;
  ROUTE_DLQ: RecordingProducer;
}

/** Bindings over the given harness database and R2 fake. */
export function integrationEnv(
  databaseName: string,
  rawArtifacts: PipelineBindings["RAW_ARTIFACTS"],
): IntegrationEnv {
  return {
    ENVIRONMENT: "local",
    ...TEST_PII_ENV,
    RAW_ARTIFACTS: rawArtifacts,
    HYPERDRIVE: {
      connectionString: withDatabase(requireDatabaseUrl(), databaseName),
    },
    DEDUPE_QUEUE: recordingProducer(),
    CLASSIFY_QUEUE: recordingProducer(),
    ROUTE_QUEUE: recordingProducer(),
    INGEST_DLQ: recordingProducer(),
    DEDUPE_DLQ: recordingProducer(),
    CLASSIFY_DLQ: recordingProducer(),
    ROUTE_DLQ: recordingProducer(),
  };
}

export interface FakeMessage extends QueueMessageLike {
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

let nextMessageId = 0;

export function fakeMessage(body: unknown): FakeMessage {
  nextMessageId += 1;
  return {
    id: `msg-${nextMessageId}`,
    timestamp: new Date("2026-07-10T12:00:00Z"),
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}
