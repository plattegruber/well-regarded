/**
 * Adapter registry (issue #104, Epic #6): the one place the pipeline's
 * normalize stage resolves a `SourceKind` to its `SourceAdapter`.
 *
 * A plain map, populated here. Real adapters slot in as they land — the
 * Google reviews adapter (Epic #7) and the CSV import adapter (Epic #8)
 * each add themselves to `defaultAdapters` in their own PR; nothing else
 * changes. An unknown kind returns `undefined`, which the normalize stage
 * treats as a non-retryable failure (straight to the DLQ) — a message for a
 * kind with no adapter can never succeed by retrying.
 *
 * `manual` currently resolves to the reference fixture adapter from #101 —
 * a stand-in with the right shape until the real manual-entry adapter ships
 * with the entry form (issue #138, Epic #8) and replaces it here.
 *
 * `registerAdapter` exists for tests (and future dynamic sources): worker
 * tests register extra fixture kinds to exercise resolve-by-sourceKind with
 * more than one adapter. Registration is process-global, which is exactly
 * what worker isolates want — one registry per isolate, assembled at module
 * load.
 */

import type { SourceKind } from "@wellregarded/core";

import { fixtureAdapter } from "./contract/fixtureAdapter.js";
import type { SourceAdapter } from "./contract/sourceAdapter.js";

const defaultAdapters: ReadonlyArray<SourceAdapter> = [
  // TODO(#138): replace with the real manual-entry adapter.
  fixtureAdapter,
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
