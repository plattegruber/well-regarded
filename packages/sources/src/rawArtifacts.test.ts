import type { R2Bucket } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";

import {
  ArtifactNotFoundError,
  computeRawArtifactKey,
  computeRawImportKey,
  getRawArtifact,
  getRawImportHead,
  putRawArtifact,
  putRawImportArtifact,
  type RawArtifactBucket,
  type RawImportBucket,
} from "./rawArtifacts.js";
import { InMemoryRawArtifactBucket } from "./testing/inMemoryBucket.js";

// Compile-time: the real R2 binding satisfies the injected interfaces, so
// workers can pass `env.<BUCKET>` straight to the helpers. (Checked by
// `pnpm typecheck`, which includes test files.)
const _realBindingSatisfiesInterface: RawArtifactBucket =
  undefined as unknown as R2Bucket;
void _realBindingSatisfiesInterface;
const _realBindingSatisfiesImportInterface: RawImportBucket =
  undefined as unknown as R2Bucket;
void _realBindingSatisfiesImportInterface;

const PRACTICE_A = "6f2f9d4e-6a2b-4c8e-9a51-000000000001";
const PRACTICE_B = "6f2f9d4e-6a2b-4c8e-9a51-000000000002";

const content = JSON.stringify({ reviews: [{ id: "r1", text: "great" }] });

describe("computeRawArtifactKey", () => {
  it("derives {practiceId}/{sourceKind}/{sha256}.json", async () => {
    const key = await computeRawArtifactKey({
      practiceId: PRACTICE_A,
      sourceKind: "google",
      content,
    });
    expect(key).toMatch(
      new RegExp(`^${PRACTICE_A}/google/[0-9a-f]{64}\\.json$`),
    );
  });

  it("is deterministic: same content yields the same key", async () => {
    const ref = {
      practiceId: PRACTICE_A,
      sourceKind: "google",
      content,
    } as const;
    expect(await computeRawArtifactKey(ref)).toBe(
      await computeRawArtifactKey({ ...ref }),
    );
  });

  it("differs for different content", async () => {
    const a = await computeRawArtifactKey({
      practiceId: PRACTICE_A,
      sourceKind: "google",
      content,
    });
    const b = await computeRawArtifactKey({
      practiceId: PRACTICE_A,
      sourceKind: "google",
      content: `${content} `,
    });
    expect(a).not.toBe(b);
  });

  it("differs for different practices (tenancy is in the key)", async () => {
    const a = await computeRawArtifactKey({
      practiceId: PRACTICE_A,
      sourceKind: "google",
      content,
    });
    const b = await computeRawArtifactKey({
      practiceId: PRACTICE_B,
      sourceKind: "google",
      content,
    });
    expect(a).not.toBe(b);
  });

  it("differs for different source kinds", async () => {
    const a = await computeRawArtifactKey({
      practiceId: PRACTICE_A,
      sourceKind: "google",
      content,
    });
    const b = await computeRawArtifactKey({
      practiceId: PRACTICE_A,
      sourceKind: "csv_import",
      content,
    });
    expect(a).not.toBe(b);
  });
});

describe("putRawArtifact", () => {
  it("writes the exact bytes under the content-addressed key", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const { key } = await putRawArtifact(bucket, {
      practiceId: PRACTICE_A,
      sourceKind: "google",
      content,
    });

    expect(key).toBe(
      await computeRawArtifactKey({
        practiceId: PRACTICE_A,
        sourceKind: "google",
        content,
      }),
    );
    const stored = bucket.objects.get(key);
    expect(stored).toBeDefined();
    expect(new TextDecoder().decode(stored?.body)).toBe(content);
  });

  it("sets contentType and custom metadata", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const before = Date.now();
    const { key } = await putRawArtifact(bucket, {
      practiceId: PRACTICE_A,
      sourceKind: "csv_import",
      content,
    });

    const stored = bucket.objects.get(key);
    expect(stored?.contentType).toBe("application/json");
    expect(stored?.customMetadata?.practiceId).toBe(PRACTICE_A);
    expect(stored?.customMetadata?.sourceKind).toBe("csv_import");
    const storedAt = Date.parse(stored?.customMetadata?.storedAt ?? "");
    expect(storedAt).toBeGreaterThanOrEqual(before);
    expect(storedAt).toBeLessThanOrEqual(Date.now());
  });

  it("is idempotent: double put of identical content writes once, no error", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const ref = {
      practiceId: PRACTICE_A,
      sourceKind: "google",
      content,
    } as const;

    const first = await putRawArtifact(bucket, ref);
    const second = await putRawArtifact(bucket, { ...ref });

    expect(second.key).toBe(first.key);
    expect(bucket.objects.size).toBe(1);
    expect(bucket.writeCount).toBe(1);
  });
});

describe("getRawArtifact", () => {
  it("round-trips a stored artifact back to its parsed form", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const payload = { reviews: [{ id: "r1", text: "great" }], next: null };
    const { key } = await putRawArtifact(bucket, {
      practiceId: PRACTICE_A,
      sourceKind: "google",
      content: JSON.stringify(payload),
    });

    await expect(getRawArtifact(bucket, key)).resolves.toEqual(payload);
  });

  it("throws ArtifactNotFoundError on a missing key (hard failure, DLQ)", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const missing = `${PRACTICE_A}/google/${"0".repeat(64)}.json`;

    const attempt = getRawArtifact(bucket, missing);
    await expect(attempt).rejects.toBeInstanceOf(ArtifactNotFoundError);
    await expect(getRawArtifact(bucket, missing)).rejects.toMatchObject({
      name: "ArtifactNotFoundError",
      key: missing,
    });
  });
});

// ---------------------------------------------------------------------------
// The `imports` context (issue #133)
// ---------------------------------------------------------------------------

const csvBytes = new TextEncoder().encode(
  "Date,Rating,Review\n2024-01-02,5,Great cleaning\n",
);

describe("computeRawImportKey / putRawImportArtifact", () => {
  it("derives {practiceId}/imports/{sha256}.csv — same path, distinct context", async () => {
    const key = await computeRawImportKey({
      practiceId: PRACTICE_A,
      bytes: csvBytes,
    });
    expect(key).toMatch(
      new RegExp(`^${PRACTICE_A}/imports/[0-9a-f]{64}\\.csv$`),
    );
  });

  it("writes the exact bytes with text/csv and imports-context metadata", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const { key } = await putRawImportArtifact(bucket, {
      practiceId: PRACTICE_A,
      bytes: csvBytes,
    });

    expect(key).toBe(
      await computeRawImportKey({ practiceId: PRACTICE_A, bytes: csvBytes }),
    );
    const stored = bucket.objects.get(key);
    expect(stored?.body).toEqual(csvBytes);
    expect(stored?.contentType).toBe("text/csv");
    expect(stored?.customMetadata?.practiceId).toBe(PRACTICE_A);
    expect(stored?.customMetadata?.context).toBe("imports");
  });

  it("is idempotent: re-uploading identical bytes writes once", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const ref = { practiceId: PRACTICE_A, bytes: csvBytes };
    const first = await putRawImportArtifact(bucket, ref);
    const second = await putRawImportArtifact(bucket, { ...ref });
    expect(second.key).toBe(first.key);
    expect(bucket.writeCount).toBe(1);
  });

  it("keys are tenant-scoped like adapter artifacts", async () => {
    const a = await computeRawImportKey({
      practiceId: PRACTICE_A,
      bytes: csvBytes,
    });
    const b = await computeRawImportKey({
      practiceId: PRACTICE_B,
      bytes: csvBytes,
    });
    expect(a).not.toBe(b);
  });
});

describe("getRawImportHead", () => {
  it("returns the whole object untruncated when it fits the window", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const { key } = await putRawImportArtifact(bucket, {
      practiceId: PRACTICE_A,
      bytes: csvBytes,
    });

    const head = await getRawImportHead(bucket, key, 1024);
    expect(head.bytes).toEqual(csvBytes);
    expect(head.truncated).toBe(false);
  });

  it("reads only the requested range of a larger object and flags truncation", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const big = new Uint8Array(10_000).fill(97); // 'a' × 10k
    const { key } = await putRawImportArtifact(bucket, {
      practiceId: PRACTICE_A,
      bytes: big,
    });

    const head = await getRawImportHead(bucket, key, 256);
    expect(head.bytes.byteLength).toBe(256);
    expect(head.truncated).toBe(true);
    // The read was ranged — the whole object was never fetched.
    expect(bucket.gets.at(-1)).toEqual({
      key,
      range: { offset: 0, length: 256 },
    });
  });

  it("throws ArtifactNotFoundError on a missing key", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    await expect(
      getRawImportHead(
        bucket,
        `${PRACTICE_A}/imports/${"0".repeat(64)}.csv`,
        256,
      ),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });
});
