/**
 * A fake Workflows step that mimics the engine's durable checkpoints: each
 * completed `step.do` result is memoized BY NAME, so re-running the same
 * workflow function against the same FakeWorkflowStep replays completed
 * steps from the cache without re-invoking their callbacks — exactly how
 * the real engine resumes an evicted or failed instance. A failed step
 * caches nothing and re-runs on the next attempt.
 */

import type { BackfillStep } from "../../src/embeddingBackfill";

export class FakeWorkflowStep implements BackfillStep {
  /** Durable checkpoint cache: step name → recorded result. */
  readonly completed = new Map<string, unknown>();
  /** Every step.do invocation that actually RAN (cache misses), in order. */
  readonly executed: string[] = [];
  /** Every sleep, as [name, durationMs]. */
  readonly sleeps: [string, number][] = [];

  async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
    if (this.completed.has(name)) {
      return this.completed.get(name) as T;
    }
    this.executed.push(name);
    const result = await callback();
    this.completed.set(name, result);
    return result;
  }

  async sleep(name: string, durationMs: number): Promise<void> {
    // Recorded, never waited: tests assert the rate-aware pauses exist
    // without paying for them.
    this.sleeps.push([name, durationMs]);
  }
}
