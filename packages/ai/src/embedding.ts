/**
 * The embedding seam (issue #106 defines it; issue #71, Epic #9 implements
 * it for real).
 *
 * `EmbeddingProvider` is the ONE interface every embedding consumer depends
 * on — the pipeline dedupe stage (#106) first, the excerpt embedding job
 * (Epic #9) next. The production implementation is Workers AI
 * `@cf/baai/bge-m3` (issue #71); until it lands, consumers that have no
 * provider wired must skip their embedding-dependent paths loudly (a
 * structured log line), never fake a vector.
 *
 * Tests use `FakeEmbeddingProvider`: a deterministic hashed bag-of-words.
 * It is NOT a semantic model — it measures token overlap — but that is
 * exactly the property dedupe tests need: identical text → identical
 * vector (cosine 1.0), a near-copy → very high cosine, unrelated text →
 * low cosine. Deterministic across processes, so failures reproduce.
 */

/** bge-m3 dimensionality — matches the `vector(1024)` columns in packages/db. */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * One function: text in, unit-length embedding out. Implementations must
 * return exactly {@link EMBEDDING_DIMENSIONS} numbers. Callers must not
 * pass empty/whitespace-only text — there is nothing to embed, and every
 * consumer's contract (e.g. dedupe's fuzzy path) skips empty text upstream.
 */
export interface EmbeddingProvider {
  embedText(text: string): Promise<number[]>;
}

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
 * Deterministic fake: lowercase word tokens, each hashed to one of the
 * 1024 dimensions (term-frequency weighted), then L2-normalized so cosine
 * similarity is a plain dot product. See the module doc for why token
 * overlap is the right fidelity for tests.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  embedText(text: string): Promise<number[]> {
    const tokens = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
    if (tokens.length === 0) {
      return Promise.reject(
        new Error(
          "FakeEmbeddingProvider.embedText: empty text — callers must skip " +
            "embedding-dependent paths for empty text, not embed it",
        ),
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
    return Promise.resolve(vector.map((value) => value / norm));
  }
}
