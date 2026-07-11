/**
 * `FakeAiProvider` — the deterministic test double (issue #63).
 *
 * THE seam every other test in the repo uses: pipeline worker tests,
 * dashboard loader tests, eval-harness tests all construct a
 * `FakeAiProvider` instead of touching the network. Guarantees:
 *
 * - **Fixture-driven**: canned responses are registered per prompt *name*
 *   (`ClassifyPrompt.name`) and returned in registration order.
 * - **Fails loudly**: an unregistered prompt, or one whose fixtures ran
 *   out, throws `FakeAiProviderError` — a test can never silently get a
 *   default response.
 * - **Schema-checked**: every fixture is validated against the same zod
 *   schema the caller passed, so fixtures cannot drift from the schema.
 * - **Recorded**: every call (including ones that threw) is appended to
 *   `provider.calls` so tests can assert on prompts, models, and counts.
 * - Zero network, zero randomness, zero clock reads.
 */

import type { z } from "zod";

import { AiError } from "./errors.js";
import type {
  AiProvider,
  AiResult,
  ClassifyOpts,
  ClassifyPrompt,
  LogicalModel,
} from "./provider.js";

/** Thrown for fixture problems — always a test bug, never caught in prod code. */
export class FakeAiProviderError extends AiError {}

/** One recorded `classify` invocation. */
export interface FakeAiCall {
  prompt: ClassifyPrompt;
  opts: ClassifyOpts;
  /** The fake model id the call resolved to (`fake-pipeline` / `fake-drafting`). */
  model: string;
}

function fakeModelId(logical: LogicalModel): string {
  return `fake-${logical}`;
}

export class FakeAiProvider implements AiProvider {
  /** Every classify() invocation, in order — assert on this in tests. */
  readonly calls: FakeAiCall[] = [];

  readonly #fixtures = new Map<string, unknown[]>();

  /**
   * @param fixtures map from prompt name to the responses returned, in
   * order, for successive calls with that prompt name.
   */
  constructor(fixtures: Record<string, unknown[]> = {}) {
    for (const [promptName, responses] of Object.entries(fixtures)) {
      this.register(promptName, ...responses);
    }
  }

  /** Queue additional canned responses for `promptName`. */
  register(promptName: string, ...responses: unknown[]): this {
    const queue = this.#fixtures.get(promptName) ?? [];
    queue.push(...responses);
    this.#fixtures.set(promptName, queue);
    return this;
  }

  async classify<T>(
    prompt: ClassifyPrompt,
    schema: z.ZodType<T>,
    opts: ClassifyOpts,
  ): Promise<AiResult<T>> {
    const model = fakeModelId(opts.model ?? "pipeline");
    this.calls.push({ prompt, opts, model });

    const queue = this.#fixtures.get(prompt.name);
    if (!queue) {
      throw new FakeAiProviderError(
        `FakeAiProvider: no fixture registered for prompt "${prompt.name}" ` +
          `(purpose "${opts.purpose}"). Register one with ` +
          `provider.register("${prompt.name}", ...) before running the code under test.`,
      );
    }
    if (queue.length === 0) {
      throw new FakeAiProviderError(
        `FakeAiProvider: fixtures for prompt "${prompt.name}" are exhausted ` +
          `(call #${this.calls.length}). Register enough responses for every expected call.`,
      );
    }
    const raw = queue.shift();

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new FakeAiProviderError(
        `FakeAiProvider: fixture for prompt "${prompt.name}" does not match the ` +
          `schema the code under test passed — fixtures must not drift from the schema. ` +
          `Issues: ${parsed.error.issues
            .map(
              (issue) =>
                `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
            )
            .join("; ")}`,
      );
    }

    return {
      value: parsed.data,
      // Deterministic usage: zero everywhere, fake model id.
      usage: { model, inputTokens: 0, outputTokens: 0, latencyMs: 0 },
    };
  }
}
