/**
 * `@wellregarded/sources` — the source-adapter foundation (Epic #6).
 *
 * Root entry is Workers-runtime clean: raw-artifact R2 helpers (issue #100)
 * and the SourceAdapter/NormalizedSignal contracts (issue #101). The shared
 * contract-test suite lives behind `@wellregarded/sources/testing` because
 * it imports vitest.
 */

export const PACKAGE_NAME = "@wellregarded/sources";

// Extensionful specifiers, matching packages/core: tsc emits these paths
// verbatim and plain Node ESM resolves only fully specified paths.
export * from "./contract/normalizedSignal.js";
export * from "./contract/sourceAdapter.js";
export * from "./rawArtifacts.js";
