import { describe, expect, it } from "vitest";

import { EMBEDDING_DIMENSIONS, FakeEmbeddingProvider } from "./embedding.js";

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
