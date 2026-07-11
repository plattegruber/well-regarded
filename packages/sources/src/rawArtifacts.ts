/**
 * R2 raw-artifact storage with content-addressed keys (issue #100, Epic #6).
 *
 * Every signal we ingest must be reproducible from the exact bytes the
 * source gave us — that is the provenance backbone for dedupe,
 * re-normalization after adapter bugs, and audit. These helpers are the only
 * way adapters and pipeline stages touch the raw-artifact bucket.
 *
 * STORE-BEFORE-ENQUEUE (the core rule)
 * ------------------------------------
 * Nothing enters an ingest queue unless its raw artifact is already durable
 * in R2. Callers MUST `await putRawArtifact(...)` and carry the returned
 * `key` in the queue message; the pipeline treats a missing artifact as a
 * hard failure (straight to the DLQ), never a retry-until-timeout. That is
 * why `getRawArtifact` throws a typed {@link ArtifactNotFoundError} instead
 * of returning `null` — a missing artifact is a contract violation, not a
 * transient condition.
 *
 * Content addressing & immutability
 * ---------------------------------
 * Keys are `{practiceId}/{sourceKind}/{sha256(content)}.json`, hashed over
 * the exact bytes written. Same content ⇒ same key, so writes are naturally
 * idempotent and it is impossible by construction to write different content
 * to an existing key — that is the reason for the scheme, not an accident of
 * it. Artifacts are never overwritten or mutated; `putRawArtifact` skips the
 * write entirely when the key already exists (idempotent re-import).
 *
 * Retention
 * ---------
 * Raw artifacts are kept indefinitely: they are the provenance record
 * backing `import_runs` and the audit story. Do NOT add a lifecycle/expiry
 * policy to this bucket, ever — "cleaning up" old artifacts destroys the
 * ability to re-derive and audit historical signals.
 *
 * Runtime constraints: this module must stay dependency-free (Web Crypto
 * only) — `@wellregarded/sources` is imported by workers and must remain
 * Workers-runtime clean. Never import `node:crypto` here.
 */

import type { SourceKind } from "@wellregarded/core";

/**
 * The structural subset of Cloudflare's `R2Bucket` these helpers need.
 *
 * Injected rather than imported so the helpers are unit-testable with an
 * in-memory fake (`InMemoryRawArtifactBucket` in `@wellregarded/sources/testing`)
 * and so this package does not force `@cloudflare/workers-types` onto its
 * consumers. The real `R2Bucket` binding satisfies this interface — a
 * compile-time assertion in `rawArtifacts.test.ts` keeps that true.
 */
export interface RawArtifactBucket {
  head(key: string): Promise<{ key: string } | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

/**
 * Thrown by {@link getRawArtifact} when the key does not exist. Pipeline
 * stages must treat this as a hard failure (DLQ) — under store-before-enqueue
 * an enqueued key always exists, so a miss means the contract was violated.
 */
export class ArtifactNotFoundError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(
      `Raw artifact not found: ${key} — store-before-enqueue was violated ` +
        "(nothing may be enqueued before its artifact is durable in R2).",
    );
    this.name = "ArtifactNotFoundError";
    this.key = key;
  }
}

export interface RawArtifactRef {
  practiceId: string;
  sourceKind: SourceKind;
  /**
   * The exact serialized payload being stored, e.g. `JSON.stringify(page)`.
   * Serialize once and pass that string — the key is the sha-256 of these
   * exact bytes, so re-serializing elsewhere invites key mismatches from
   * key-ordering differences.
   */
  content: string;
}

const encoder = new TextEncoder();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Derives the content-addressed key `{practiceId}/{sourceKind}/{sha256}.json`
 * for a payload without writing anything. Deterministic: identical content
 * always yields the identical key.
 */
export async function computeRawArtifactKey({
  practiceId,
  sourceKind,
  content,
}: RawArtifactRef): Promise<string> {
  const hash = await sha256Hex(encoder.encode(content));
  return `${practiceId}/${sourceKind}/${hash}.json`;
}

/**
 * Stores a raw artifact under its content-addressed key and returns the key.
 *
 * Must be awaited BEFORE enqueueing any pipeline message referencing the
 * artifact (store-before-enqueue — see module doc). Idempotent: if the key
 * already exists the write is skipped, which is safe precisely because
 * content addressing makes it impossible for an existing key to hold
 * different content.
 *
 * The object is written with `contentType: application/json` and custom
 * metadata (`practiceId`, `sourceKind`, `storedAt`).
 */
export async function putRawArtifact(
  bucket: RawArtifactBucket,
  { practiceId, sourceKind, content }: RawArtifactRef,
): Promise<{ key: string }> {
  // Encode once; hash and write the same buffer (issue #100 implementation
  // note — hashing a re-serialized copy invites key mismatches).
  const bytes = encoder.encode(content);
  const hash = await sha256Hex(bytes);
  const key = `${practiceId}/${sourceKind}/${hash}.json`;

  const existing = await bucket.head(key);
  if (existing !== null) {
    // Idempotent re-import: same content ⇒ same key ⇒ nothing to do.
    return { key };
  }

  await bucket.put(key, bytes, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      practiceId,
      sourceKind,
      storedAt: new Date().toISOString(),
    },
  });

  return { key };
}

/**
 * Reads and JSON-parses a raw artifact. Throws {@link ArtifactNotFoundError}
 * on a missing key so pipeline stages fail loudly (DLQ), never silently.
 */
export async function getRawArtifact(
  bucket: RawArtifactBucket,
  key: string,
): Promise<unknown> {
  const object = await bucket.get(key);
  if (object === null) {
    throw new ArtifactNotFoundError(key);
  }
  return JSON.parse(await object.text());
}
