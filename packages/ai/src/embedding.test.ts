import { describe, expect, it } from "vitest";

import {
  createWorkersAiEmbedder,
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIMENSIONS,
  EmbeddingDimensionError,
  FakeEmbeddingProvider,
  fakeEmbed,
  type WorkersAiBinding,
} from "./embedding.js";
import { AiResponseError } from "./errors.js";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

describe("FakeEmbeddingProvider", () => {
  const provider = new FakeEmbeddingProvider();

  it("returns a unit vector of the bge-m3 dimensionality", async () => {
    const vector = await provider.embedText("The team was gentle and kind.");
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it("is deterministic: identical text embeds identically", async () => {
    const text = "Dr. Patel was wonderful with my daughter.";
    expect(await provider.embedText(text)).toEqual(
      await provider.embedText(text),
    );
  });

  it("scores near-copies high and unrelated text low (the dedupe fidelity)", async () => {
    const original =
      "Dr. Patel was wonderful with my daughter — she actually looks " +
      "forward to the dentist now and asks when we can go back.";
    const nearCopy =
      "Dr. Patel was wonderful with my daughter - she actually looks " +
      "forward to the dentist now and asks when we can go back!";
    const unrelated =
      "Billing was a mess for months and nobody at the front desk could " +
      "explain the insurance charges on my statement.";

    const [a, b, c] = await Promise.all([
      provider.embedText(original),
      provider.embedText(nearCopy),
      provider.embedText(unrelated),
    ]);
    expect(cosine(a, b)).toBeGreaterThan(0.92);
    expect(cosine(a, c)).toBeLessThan(0.5);
  });

  it("rejects empty text — callers must skip, not embed, the void", async () => {
    await expect(provider.embedText("   ")).rejects.toThrow(/empty text/);
  });
});

/** A fake AI binding that echoes recognizable vectors per input. */
function fakeBinding(
  vectorFor: (text: string) => number[],
): WorkersAiBinding & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (_model, inputs) => {
      calls.push([...inputs.text]);
      return { data: inputs.text.map(vectorFor), shape: [inputs.text.length] };
    },
  };
}

/** A valid vector whose first component tags the input it embeds. */
function taggedVector(tag: number): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = tag;
  return vector;
}

describe("createWorkersAiEmbedder", () => {
  it("batches 123 texts into 3 calls of ≤50 and preserves order", async () => {
    const texts = Array.from({ length: 123 }, (_, index) => `text-${index}`);
    const binding = fakeBinding((text) =>
      taggedVector(Number(text.split("-")[1])),
    );
    const embedder = createWorkersAiEmbedder(binding);

    const vectors = await embedder.embed(texts);

    expect(binding.calls.map((call) => call.length)).toEqual([50, 50, 23]);
    expect(EMBEDDING_BATCH_SIZE).toBe(50);
    expect(vectors).toHaveLength(123);
    // Order preserved end to end: vector i carries text i's tag.
    vectors.forEach((vector, index) => {
      expect(vector[0]).toBe(index);
    });
  });

  it("embedText delegates to the batch primitive and unwraps one vector", async () => {
    const binding = fakeBinding(() => taggedVector(7));
    const embedder = createWorkersAiEmbedder(binding);
    const vector = await embedder.embedText("hello");
    expect(vector[0]).toBe(7);
    expect(binding.calls).toEqual([["hello"]]);
  });

  it("throws EmbeddingDimensionError on a wrong-dimensional vector", async () => {
    const binding = fakeBinding(() => [0.1, 0.2, 0.3]);
    const embedder = createWorkersAiEmbedder(binding);
    await expect(embedder.embed(["hello"])).rejects.toThrow(
      EmbeddingDimensionError,
    );
    await expect(embedder.embed(["hello"])).rejects.toThrow(/1024/);
  });

  it("throws AiResponseError on an unexpected response shape", async () => {
    const embedder = createWorkersAiEmbedder({
      run: async () => ({ embeddings: [[1, 2]] }),
    });
    await expect(embedder.embed(["hello"])).rejects.toThrow(AiResponseError);
  });

  it("throws AiResponseError when the vector count disagrees with the input count", async () => {
    const embedder = createWorkersAiEmbedder({
      run: async () => ({ data: [taggedVector(1)] }),
    });
    await expect(embedder.embed(["a", "b"])).rejects.toThrow(/2 inputs/);
  });

  it("stamps the bge-m3 model id", () => {
    const embedder = createWorkersAiEmbedder(
      fakeBinding(() => taggedVector(0)),
    );
    expect(embedder.model).toBe("@cf/baai/bge-m3");
  });
});

describe("fakeEmbed + FakeEmbeddingProvider batch path", () => {
  it("puts a shared-vocabulary paraphrase nearer than an unrelated text (retrieval fidelity)", () => {
    const [excerpt, paraphrase, unrelated] = fakeEmbed([
      "The billing was confusing and nobody could tell me what I owed.",
      "confusing billing nobody explained what I owed",
      "Parking out front was easy and spacious.",
    ]);
    expect(cosine(paraphrase ?? [], excerpt ?? [])).toBeGreaterThan(
      cosine(unrelated ?? [], excerpt ?? []),
    );
  });

  it("records calls and supports failure injection", async () => {
    const boom = new Error("embedding service down");
    const provider = new FakeEmbeddingProvider({
      shouldFail: ({ index }) => (index === 1 ? boom : undefined),
    });
    await expect(provider.embed(["a"])).resolves.toHaveLength(1);
    await expect(provider.embed(["b"])).rejects.toThrow(boom);
    await expect(provider.embed(["c"])).resolves.toHaveLength(1);
    expect(provider.calls).toEqual([["a"], ["b"], ["c"]]);
    expect(provider.model).toBe("fake-bge-m3");
  });
});
