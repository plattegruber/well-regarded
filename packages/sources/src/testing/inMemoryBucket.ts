/**
 * In-memory fake of {@link RawArtifactBucket} / {@link RawImportBucket} for
 * unit tests — no Miniflare needed. Records enough (bodies, metadata, write
 * count, get calls) for tests to assert the idempotent-put behavior, the
 * metadata contract, and — for the CSV-import preview path (issue #133) —
 * that reads are RANGED, never whole-object.
 */

import type { RawImportBucket } from "../rawArtifacts.js";

export interface StoredArtifact {
  body: Uint8Array;
  contentType: string | undefined;
  customMetadata: Record<string, string> | undefined;
}

/** One recorded `get` call — `range` mirrors what the caller passed. */
export interface RecordedGet {
  key: string;
  range?: { offset: number; length: number };
}

export class InMemoryRawArtifactBucket implements RawImportBucket {
  readonly objects = new Map<string, StoredArtifact>();
  /** Number of actual writes — an idempotent skipped put does not count. */
  writeCount = 0;
  /** Every `get` call, in order — lets tests assert ranged reads. */
  readonly gets: RecordedGet[] = [];

  head(key: string): Promise<{ key: string } | null> {
    return Promise.resolve(this.objects.has(key) ? { key } : null);
  }

  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown> {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value.slice(0))
        : new Uint8Array(
            value.buffer.slice(
              value.byteOffset,
              value.byteOffset + value.byteLength,
            ),
          );
    this.objects.set(key, {
      body: bytes,
      contentType: options?.httpMetadata?.contentType,
      customMetadata: options?.customMetadata,
    });
    this.writeCount += 1;
    return Promise.resolve({ key });
  }

  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<{
    size: number;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
  } | null> {
    this.gets.push({
      key,
      ...(options?.range ? { range: options.range } : {}),
    });
    const stored = this.objects.get(key);
    if (stored === undefined) return Promise.resolve(null);
    // R2 semantics: `size` is the TOTAL object size; the body is the range.
    const body = options?.range
      ? stored.body.slice(
          options.range.offset,
          options.range.offset + options.range.length,
        )
      : stored.body;
    return Promise.resolve({
      size: stored.body.byteLength,
      arrayBuffer: () =>
        Promise.resolve(
          body.buffer.slice(
            body.byteOffset,
            body.byteOffset + body.byteLength,
          ) as ArrayBuffer,
        ),
      text: () => Promise.resolve(new TextDecoder().decode(body)),
    });
  }
}
