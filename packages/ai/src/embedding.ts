/**
 * The embedding seam (defined by issue #106, implemented for real by
 * issue #71, Epic #9).
 *
 * `EmbeddingProvider` is the ONE interface every embedding consumer
 * depends on — the pipeline dedupe stage's fuzzy path (#106), the classify
 * stage's inline excerpt embedding (#69/#71), and the backfill Workflow in
 * `workers/jobs` (#71). Production is `createWorkersAiEmbedder` over the
 * injected Workers AI binding (`env.AI.run("@cf/baai/bge-m3", ...)`); the
 * binding is passed in, never imported, so this package stays
 * platform-thin. Consumers with no provider wired must skip their
 * embedding-dependent paths loudly (a structured log line), never fake a
 * vector.
 *
 * Two call shapes, one contract: `embed(texts[])` is the batch primitive
 * (order-preserving, one vector per text); `embedText(text)` is the
 * single-text convenience the dedupe path uses. Callers must not pass
 * empty/whitespace-only text — there is nothing to embed, and every
 * consumer's contract skips empty text upstream. Every vector is
 * unit-length with exactly {@link EMBEDDING_DIMENSIONS} numbers.
 *
 * Deliberately NOT part of `AiProvider`: classification and embedding have
 * different providers, different fakes, and different failure semantics
 * (an embedding failure degrades to a NULL column the backfill sweeps up;
 * a classification failure blocks the signal).
 *
 * bge-m3 is swappable by design — vectors live in pgvector and
 * `proof_excerpts` records `embedding_model` per row, so a future model
 * migration is a re-embed job (filter `WHERE embedding_model !=
 * $current`), not archaeology.
 *
 * Tests use `FakeEmbeddingProvider`: a deterministic hashed bag-of-words.
 * It is NOT a semantic model — it measures token overlap — but that is
 * exactly the fidelity tests need: identical text → identical vector
 * (cosine 1.0), a near-copy → very high cosine, a shared-vocabulary
 * paraphrase → nearer than unrelated text. Deterministic across
 * processes, so failures reproduce and retrieval tests get stable
 * neighbors.
 */

import { z } from "zod";

import { AiError, AiResponseError } from "./errors.js";

/** bge-m3 dimensionality — matches the `vector(1024)` columns in packages/db. */
export const EMBEDDING_DIMENSIONS = 1024;

/** The Workers AI model id — also the `embedding_model` column default. */
export const BGE_M3_EMBEDDING_MODEL = "@cf/baai/bge-m3";

/**
 * Texts per Workers AI call. The binding accepts up to 100 for bge-m3;
 * batch at 50 to stay clear of the limit (issue #71 requirement 1).
 */
export const EMBEDDING_BATCH_SIZE = 50;

/**
 * The embedding seam. `embed` is the batch primitive: order-preserving,
 * `result[i]` embeds `texts[i]`. `embedText` is the one-text convenience.
 */
export interface EmbeddingProvider {
  /** Concrete model id, stamped into `proof_excerpts.embedding_model`. */
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
  embedText(text: string): Promise<number[]>;
}

/**
 * Structural subset of the Workers AI binding (`env.AI`) — what the
 * embedder actually calls, so tests can inject a plain object and workers
 * can pass the real binding without this package importing workers-types.
 */
export interface WorkersAiBinding {
  run(model: string, inputs: { text: string[] }): Promise<unknown>;
}

/**
 * The model returned vectors of the wrong dimensionality — fail loudly
 * (issue #71 requirement 1): a silently truncated or padded vector would
 * poison the HNSW index with garbage neighbors.
 */
export class EmbeddingDimensionError extends AiError {
  constructor(expected: number, actual: number, model: string) {
    super(
      `Embedding model ${model} returned a ${actual}-dim vector; expected ` +
        `${expected} (the pgvector columns are vector(${expected})).`,
    );
  }
}

/**
 * Workers AI bge-m3 multi-input response: `{ data: number[][] }` (extra
 * keys like `shape` tolerated). Pinned with zod per the issue — a shape
 * drift in the binding must be a loud typed error, not `undefined is not
 * a function` three layers down.
 */
const workersAiEmbeddingResponseSchema = z.object({
  data: z.array(z.array(z.number())),
});

export interface WorkersAiEmbedderOptions {
  /** Override the model id (default bge-m3). Dims stay 1024 regardless. */
  model?: string;
  /** Override the per-call batch size (default 50, for tests). */
  batchSize?: number;
}

/**
 * The production `EmbeddingProvider` over a Workers AI binding. Batches
 * input, preserves order, validates the response shape and every vector's
 * dimensionality.
 */
export function createWorkersAiEmbedder(
  ai: WorkersAiBinding,
  options: WorkersAiEmbedderOptions = {},
): EmbeddingProvider {
  const model = options.model ?? BGE_M3_EMBEDDING_MODEL;
  const batchSize = options.batchSize ?? EMBEDDING_BATCH_SIZE;
  return {
    model,
    async embed(texts: string[]): Promise<number[][]> {
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const batch = texts.slice(start, start + batchSize);
        const raw = await ai.run(model, { text: batch });
        const parsed = workersAiEmbeddingResponseSchema.safeParse(raw);
        if (!parsed.success) {
          throw new AiResponseError(
            `Workers AI ${model} returned an unexpected response shape: ` +
              parsed.error.issues.map((issue) => issue.message).join("; "),
            { stopReason: null },
          );
        }
        if (parsed.data.data.length !== batch.length) {
          throw new AiResponseError(
            `Workers AI ${model} returned ${parsed.data.data.length} vectors ` +
              `for ${batch.length} inputs — order can no longer be trusted.`,
            { stopReason: null },
          );
        }
        for (const vector of parsed.data.data) {
          if (vector.length !== EMBEDDING_DIMENSIONS) {
            throw new EmbeddingDimensionError(
              EMBEDDING_DIMENSIONS,
              vector.length,
              model,
            );
          }
          vectors.push(vector);
        }
      }
      return vectors;
    },
    async embedText(text: string): Promise<number[]> {
      const [vector] = await this.embed([text]);
      // embed() validated count and dimensions; one input → one vector.
      return vector as number[];
    },
  };
}

/** Model id stamped by the fake — never a real Workers AI model. */
export const FAKE_EMBEDDING_MODEL = "fake-bge-m3";

/**
 * FNV-1a 32-bit — a tiny, stable string hash. Not cryptographic; it only
 * needs to spread tokens across the vector's dimensions deterministically.
 */
function fnv1a(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * One deterministic unit vector: lowercase word tokens, each hashed to
 * one of the 1024 dimensions (term-frequency weighted), then
 * L2-normalized so cosine similarity is a plain dot product. Throws on
 * token-free text — callers must skip embedding-dependent paths for empty
 * text, not embed it.
 */
function fakeVector(text: string): number[] {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  if (tokens.length === 0) {
    throw new Error(
      "fakeEmbed: empty text — callers must skip embedding-dependent " +
        "paths for empty text, not embed it",
    );
  }
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const token of tokens) {
    const dimension = fnv1a(token) % EMBEDDING_DIMENSIONS;
    vector[dimension] = (vector[dimension] ?? 0) + 1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  return vector.map((value) => value / norm);
}

/**
 * Deterministic embeddings for `texts`, order-preserving, unit-normed —
 * the same function `FakeEmbeddingProvider` uses, exported so tests can
 * build query vectors that are genuinely near a fake-embedded row.
 */
export function fakeEmbed(texts: string[]): number[][] {
  return texts.map(fakeVector);
}

export interface FakeEmbeddingProviderOptions {
  /**
   * Failure injection: called before each `embed`/`embedText`; a returned
   * error is thrown instead of embedding (e.g. fail call #2 to test
   * backfill resumability and the classify degrade-to-NULL path).
   */
  shouldFail?: (call: { index: number; texts: string[] }) => Error | undefined;
}

/**
 * The injectable test double (see the module doc for the hashed
 * bag-of-words fidelity argument). Records every call, embeds via
 * `fakeEmbed`, rejects token-free text.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly model = FAKE_EMBEDDING_MODEL;
  /** Every embed()/embedText() invocation's texts, in order. */
  readonly calls: string[][] = [];

  readonly #shouldFail: FakeEmbeddingProviderOptions["shouldFail"];

  constructor(options: FakeEmbeddingProviderOptions = {}) {
    this.#shouldFail = options.shouldFail;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const index = this.calls.length;
    this.calls.push([...texts]);
    const failure = this.#shouldFail?.({ index, texts });
    if (failure) throw failure;
    return fakeEmbed(texts);
  }

  async embedText(text: string): Promise<number[]> {
    const [vector] = await this.embed([text]);
    return vector as number[];
  }
}
