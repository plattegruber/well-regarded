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
 * Keys are `{practiceId}/{context}/{sha256(content)}.{ext}`, hashed over
 * the exact bytes written. Same content ⇒ same key, so writes are naturally
 * idempotent and it is impossible by construction to write different content
 * to an existing key — that is the reason for the scheme, not an accident of
 * it. Artifacts are never overwritten or mutated; the put helpers skip the
 * write entirely when the key already exists (idempotent re-import).
 *
 * Two contexts share this one storage path (issue #133 — do NOT fork a
 * second one):
 * - adapter payloads: `{practiceId}/{sourceKind}/{sha256}.json`
 *   ({@link putRawArtifact}), where `context` is a `SourceKind`;
 * - uploaded CSV imports: `{practiceId}/imports/{sha256}.csv`
 *   ({@link putRawImportArtifact}), where `context` is the literal
 *   `imports` segment ({@link RAW_IMPORT_CONTEXT} — reserved, not a
 *   `SourceKind`, so the two can never collide).
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

// ---------------------------------------------------------------------------
// The `imports` context (issue #133, Epic #8) — uploaded CSV files.
// ---------------------------------------------------------------------------

/**
 * The key segment for uploaded import files, sitting where a `SourceKind`
 * sits for adapter payloads: `{practiceId}/imports/{sha256}.csv`. Reserved:
 * `"imports"` must never be added to `SOURCE_KINDS`, or the two contexts
 * would collide in one namespace.
 */
export const RAW_IMPORT_CONTEXT = "imports";

/**
 * What {@link putRawImportArtifact} and the preview read need from the
 * bucket, over and above {@link RawArtifactBucket}: a ranged `get` (the
 * preview reads only the head of a possibly-50MB object) whose result
 * carries the full object `size` (so callers can tell a truncated read
 * from a short file) and raw bytes. The real `R2Bucket` satisfies this —
 * the compile-time assertion in `rawArtifacts.test.ts` keeps that true.
 * Note: R2 semantics — `size` is the TOTAL object size even for a ranged
 * read; `arrayBuffer()` returns only the requested range.
 */
export interface RawImportBucket extends RawArtifactBucket {
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<{
    size: number;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
  } | null>;
}

export interface RawImportRef {
  practiceId: string;
  /**
   * The exact uploaded bytes. Bytes, not a string, on purpose: a CSV is
   * user-supplied binary until proven otherwise, and decoding it to a
   * string before hashing would both risk lossy transcoding and double
   * the memory (UTF-16) of a large upload.
   */
  bytes: Uint8Array;
}

/**
 * Derives `{practiceId}/imports/{sha256(bytes)}.csv` without writing.
 * Deterministic, same contract as {@link computeRawArtifactKey}.
 */
export async function computeRawImportKey({
  practiceId,
  bytes,
}: RawImportRef): Promise<string> {
  const hash = await sha256Hex(bytes);
  return `${practiceId}/${RAW_IMPORT_CONTEXT}/${hash}.csv`;
}

/**
 * Stores an uploaded CSV under its content-addressed key and returns the
 * key. Same rules as {@link putRawArtifact}: await it before persisting
 * anything that references the key (store-before-reference), idempotent
 * on re-upload of identical bytes. Written with `contentType: text/csv`
 * and custom metadata (`practiceId`, `context`, `storedAt`).
 */
export async function putRawImportArtifact(
  bucket: RawImportBucket,
  { practiceId, bytes }: RawImportRef,
): Promise<{ key: string }> {
  const hash = await sha256Hex(bytes);
  const key = `${practiceId}/${RAW_IMPORT_CONTEXT}/${hash}.csv`;

  const existing = await bucket.head(key);
  if (existing !== null) {
    // Idempotent re-upload: same bytes ⇒ same key ⇒ nothing to do.
    return { key };
  }

  await bucket.put(key, bytes, {
    httpMetadata: { contentType: "text/csv" },
    customMetadata: {
      practiceId,
      context: RAW_IMPORT_CONTEXT,
      storedAt: new Date().toISOString(),
    },
  });

  return { key };
}

/**
 * Reads the first `maxBytes` of a stored import via a ranged get — the
 * preview path (issue #133 req. 2) that must never materialize the whole
 * file. Throws {@link ArtifactNotFoundError} on a missing key.
 * `truncated` is true when the object continues past the returned bytes
 * (callers then drop the final partial CSV row).
 */
export async function getRawImportHead(
  bucket: RawImportBucket,
  key: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const object = await bucket.get(key, {
    range: { offset: 0, length: maxBytes },
  });
  if (object === null) {
    throw new ArtifactNotFoundError(key);
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  return { bytes, truncated: object.size > bytes.byteLength };
}
