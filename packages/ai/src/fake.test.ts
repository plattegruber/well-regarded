import { describe, expect, it } from "vitest";
import { z } from "zod";

import { FakeAiProvider, FakeAiProviderError } from "./fake.js";
import type { ClassifyOpts, ClassifyPrompt } from "./provider.js";

const schema = z.object({
  sentiment: z.enum(["positive", "negative"]),
  confidence: z.number(),
});

const prompt: ClassifyPrompt = {
  name: "judgments/v1",
  user: "Review: the hygienist was wonderful.",
};

const opts: ClassifyOpts = { purpose: "judgments", practiceId: null };

describe("FakeAiProvider", () => {
  it("returns fixtures deterministically, in registration order", async () => {
    const provider = new FakeAiProvider({
      "judgments/v1": [
        { sentiment: "positive", confidence: 0.9 },
        { sentiment: "negative", confidence: 0.4 },
      ],
    });

    const first = await provider.classify(prompt, schema, opts);
    const second = await provider.classify(prompt, schema, opts);

    expect(first.value).toEqual({ sentiment: "positive", confidence: 0.9 });
    expect(second.value).toEqual({ sentiment: "negative", confidence: 0.4 });
    // Deterministic usage: zero tokens, zero latency, fake model id.
    expect(first.usage).toEqual({
      model: "fake-pipeline",
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
    });
  });

  it("throws loudly on an unregistered prompt name", async () => {
    const provider = new FakeAiProvider();
    await expect(provider.classify(prompt, schema, opts)).rejects.toThrow(
      FakeAiProviderError,
    );
    await expect(provider.classify(prompt, schema, opts)).rejects.toThrow(
      /no fixture registered for prompt "judgments\/v1"/,
    );
  });

  it("throws loudly when fixtures run out", async () => {
    const provider = new FakeAiProvider().register("judgments/v1", {
      sentiment: "positive",
      confidence: 1,
    });
    await provider.classify(prompt, schema, opts);
    await expect(provider.classify(prompt, schema, opts)).rejects.toThrow(
      /fixtures for prompt "judgments\/v1" are exhausted/,
    );
  });

  it("validates fixtures against the caller's schema so they cannot drift", async () => {
    const provider = new FakeAiProvider().register("judgments/v1", {
      sentiment: "ecstatic", // not in the enum
      confidence: 0.9,
    });
    await expect(provider.classify(prompt, schema, opts)).rejects.toThrow(
      /does not match the schema/,
    );
  });

  it("records every call — prompt, opts, and resolved model", async () => {
    const provider = new FakeAiProvider()
      .register("judgments/v1", { sentiment: "positive", confidence: 0.8 })
      .register("drafts/v1", { sentiment: "negative", confidence: 0.2 });

    await provider.classify(prompt, schema, opts);
    await provider.classify(
      { name: "drafts/v1", user: "Draft a reply." },
      schema,
      { purpose: "drafting", practiceId: "p-1", model: "drafting" },
    );
    // A throwing call is still recorded.
    await expect(
      provider.classify({ name: "unknown", user: "?" }, schema, opts),
    ).rejects.toThrow(FakeAiProviderError);

    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[0]).toMatchObject({
      prompt: { name: "judgments/v1" },
      opts: { purpose: "judgments", practiceId: null },
      model: "fake-pipeline",
    });
    expect(provider.calls[1]).toMatchObject({
      prompt: { name: "drafts/v1" },
      opts: { purpose: "drafting", practiceId: "p-1", model: "drafting" },
      model: "fake-drafting",
    });
    expect(provider.calls[2]?.prompt.name).toBe("unknown");
  });
});
