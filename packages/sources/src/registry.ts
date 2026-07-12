/**
 * Adapter registry (issue #104, Epic #6): the one place the pipeline's
 * normalize stage resolves a `SourceKind` to its `SourceAdapter`.
 *
 * A plain map, populated here. Real adapters slot in as they land — the
 * Google reviews adapter (#125, Epic #7) and the CSV import adapter
 * (#135, Epic #8) are in; nothing else changes when the next one lands.
 * An unknown kind returns `undefined`, which the normalize stage
 * treats as a non-retryable failure (straight to the DLQ) — a message for a
 * kind with no adapter can never succeed by retrying.
 *
 * `manual` resolves to the real manual-entry adapter (#138, Epic #8),
 * which replaced the #101 reference fixture adapter that used to hold the
 * slot (the fixture adapter stays exported from `/testing` for the
 * contract suite's meta-tests, unregistered).
 *
 * `registerAdapter` exists for tests (and future dynamic sources): worker
 * tests register extra fixture kinds to exercise resolve-by-sourceKind with
 * more than one adapter. Registration is process-global, which is exactly
 * what worker isolates want — one registry per isolate, assembled at module
 * load.
 */

import type { SourceKind } from "@wellregarded/core";

import type { SourceAdapter } from "./contract/sourceAdapter.js";
import { csvImportAdapter } from "./csv/adapter.js";
import { googleReviewsAdapter } from "./google/adapter.js";
import { manualEntryAdapter } from "./manual/adapter.js";

const defaultAdapters: ReadonlyArray<SourceAdapter> = [
  manualEntryAdapter,
  googleReviewsAdapter,
  csvImportAdapter,
];

const registry = new Map<SourceKind, SourceAdapter>(
  defaultAdapters.map((adapter) => [adapter.sourceKind, adapter]),
);

/** Resolve the adapter for a source kind; `undefined` when none exists. */
export function getAdapter(sourceKind: SourceKind): SourceAdapter | undefined {
  return registry.get(sourceKind);
}

/**
 * Register an adapter for its `sourceKind`. Throws on a duplicate kind —
 * two adapters claiming one kind is always a wiring bug. Tests that need to
 * swap an adapter unregister first via `resetAdapterRegistry`.
 */
export function registerAdapter(adapter: SourceAdapter): void {
  if (registry.has(adapter.sourceKind)) {
    throw new Error(
      `registerAdapter: an adapter for "${adapter.sourceKind}" is already registered`,
    );
  }
  registry.set(adapter.sourceKind, adapter);
}

/**
 * Restore the registry to its default contents. TEST-ONLY: production code
 * never mutates the registry after module load.
 */
export function resetAdapterRegistry(): void {
  registry.clear();
  for (const adapter of defaultAdapters) {
    registry.set(adapter.sourceKind, adapter);
  }
}
