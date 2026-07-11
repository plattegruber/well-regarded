/**
 * OPTIONAL live smoke test against the real Anthropic API.
 *
 * Gated on `ANTHROPIC_API_KEY` in the process env: without it the suite
 * skips (loudly — see the console.warn below). No key exists in the repo
 * or in CI today, so this never runs there; wiring evals (and a key) into
 * CI is issue #73. To run it locally:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @wellregarded/ai test
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AnthropicProvider } from "./anthropic.js";

const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  console.warn(
    "[@wellregarded/ai] ANTHROPIC_API_KEY is not set — skipping the live " +
      "Anthropic smoke test. This is expected everywhere except a manual " +
      "local run; CI eval wiring is issue #73.",
  );
}

describe.skipIf(!apiKey)("AnthropicProvider live smoke test", () => {
  it("classifies a trivial sentiment through the real API", async () => {
    const provider = new AnthropicProvider({
      // biome-ignore lint/style/noNonNullAssertion: guarded by skipIf above
      apiKey: apiKey!,
      models: {
        pipeline: "claude-haiku-4-5-20251001",
        drafting: "claude-sonnet-5",
      },
    });

    const result = await provider.classify(
      {
        name: "smoke/sentiment",
        system: "Classify the sentiment of the review.",
        user: "Review: the whole team was kind and the visit was painless.",
      },
      z.object({
        sentiment: z.enum(["positive", "neutral", "negative"]),
        confidence: z.number(),
      }),
      { purpose: "smoke-test", practiceId: null },
    );

    expect(result.value.sentiment).toBe("positive");
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  }, 60_000);
});
