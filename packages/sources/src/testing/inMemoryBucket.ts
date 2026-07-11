/**
 * In-memory fake of {@link RawArtifactBucket} for unit tests — no Miniflare
 * needed. Records enough (bodies, metadata, write count) for tests to assert
 * the idempotent-put behavior and metadata contract of `putRawArtifact`.
 */

import type { RawArtifactBucket } from "../rawArtifacts.js";

export interface StoredArtifact {
  body: Uint8Array;
  contentType: string | undefined;
  customMetadata: Record<string, string> | undefined;
}

export class InMemoryRawArtifactBucket implements RawArtifactBucket {
  readonly objects = new Map<string, StoredArtifact>();
  /** Number of actual writes — an idempotent skipped put does not count. */
  writeCount = 0;

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

  get(key: string): Promise<{ text(): Promise<string> } | null> {
    const stored = this.objects.get(key);
    if (stored === undefined) return Promise.resolve(null);
    return Promise.resolve({
      text: () => Promise.resolve(new TextDecoder().decode(stored.body)),
    });
  }
}
