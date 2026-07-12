/**
 * Shared SourceAdapter contract-test suite (issue #101, Epic #6).
 *
 * Every adapter — google, csv, manual, firstparty, opendental — proves
 * itself against this suite before it ever touches the pipeline. An
 * adapter's test file invokes:
 *
 * ```ts
 * import { describeAdapterContract } from "@wellregarded/sources/testing";
 *
 * describeAdapterContract(myAdapter, {
 *   valid: [{ name: "one page of reviews", artifact: recordedPage, expectedCount: 3 }],
 *   empty: recordedEmptyPage,
 * });
 * ```
 *
 * Fixtures are recorded-shape payloads: exactly what `getRawArtifact` would
 * return for that source. Adapters add source-specific assertions in their
 * own tests; this suite covers only the cross-source invariants.
 *
 * This module imports `vitest` and therefore lives behind the
 * `@wellregarded/sources/testing` subpath — never import it (or anything
 * from `./testing`) in worker runtime code.
 */

import { describe, expect, it } from "vitest";

import { normalizedSignalSchema } from "./normalizedSignal.js";
import type { SourceAdapter } from "./sourceAdapter.js";

/** One recorded-shape payload the adapter must normalize correctly. */
export interface AdapterContractFixture {
  /** Human-readable label, used in test names. */
  name: string;
  /** The parsed raw artifact, exactly as `getRawArtifact` returns it. */
  artifact: unknown;
  /** How many NormalizedSignals the adapter must produce from it. */
  expectedCount: number;
}

export interface AdapterContractFixtures {
  /** At least one realistic payload. */
  valid: AdapterContractFixture[];
  /**
   * A degenerate input (empty page / empty batch) the adapter must handle
   * without throwing, yielding `[]`.
   */
  empty: unknown;
}

type ContractCheck = (
  adapter: SourceAdapter,
  fixtures: AdapterContractFixtures,
) => Promise<void>;

/**
 * The individual contract checks, exported so meta-tests can assert that a
 * deliberately broken adapter fails a specific check
 * (`await expect(check(broken, fixtures)).rejects.toThrow()`), which is hard
 * to do through vitest's own `describe` registration.
 */
export const adapterContractChecks: Record<string, ContractCheck> = {
  "every signal passes the strict NormalizedSignal schema": async (
    adapter,
    fixtures,
  ) => {
    for (const fixture of fixtures.valid) {
      const signals = await adapter.normalize(fixture.artifact);
      for (const signal of signals) {
        // strictObject: unknown keys reject, typo'd fields fail loudly here.
        normalizedSignalSchema.parse(signal);
      }
    }
  },

  "produces the expected number of signals per fixture": async (
    adapter,
    fixtures,
  ) => {
    for (const fixture of fixtures.valid) {
      const signals = await adapter.normalize(fixture.artifact);
      expect(signals, `fixture "${fixture.name}"`).toHaveLength(
        fixture.expectedCount,
      );
    }
  },

  "every signal's sourceKind matches the adapter's": async (
    adapter,
    fixtures,
  ) => {
    for (const fixture of fixtures.valid) {
      for (const signal of await adapter.normalize(fixture.artifact)) {
        expect(signal.sourceKind, `fixture "${fixture.name}"`).toBe(
          adapter.sourceKind,
        );
      }
    }
  },

  "sourceIds are stable across repeated normalization": async (
    adapter,
    fixtures,
  ) => {
    // Dedupe depends on this: the same artifact must always yield the same
    // sourceIds, in the same order.
    for (const fixture of fixtures.valid) {
      const first = (await adapter.normalize(fixture.artifact)).map(
        (signal) => signal.sourceId,
      );
      const second = (await adapter.normalize(fixture.artifact)).map(
        (signal) => signal.sourceId,
      );
      expect(second, `fixture "${fixture.name}"`).toEqual(first);
    }
  },

  "a degenerate artifact yields [] without throwing": async (
    adapter,
    fixtures,
  ) => {
    await expect(adapter.normalize(fixtures.empty)).resolves.toEqual([]);
  },

  "emits patientHint only when supportsIdentity": async (adapter, fixtures) => {
    if (adapter.capabilities.supportsIdentity) return;
    for (const fixture of fixtures.valid) {
      for (const signal of await adapter.normalize(fixture.artifact)) {
        expect(signal.patientHint, `fixture "${fixture.name}"`).toBe(undefined);
      }
    }
  },

  "emits consentHint only when supportsConsent": async (adapter, fixtures) => {
    if (adapter.capabilities.supportsConsent) return;
    for (const fixture of fixtures.valid) {
      for (const signal of await adapter.normalize(fixture.artifact)) {
        expect(signal.consentHint, `fixture "${fixture.name}"`).toBe(undefined);
        expect(signal.consentDetail, `fixture "${fixture.name}"`).toBe(
          undefined,
        );
      }
    }
  },

  "consentDetail only accompanies a practice_attested hint": async (
    adapter,
    fixtures,
  ) => {
    // Detail is the attestation's specifics; it cannot exist without the
    // attestation itself (the normalize seam keys the consents write on
    // the hint and reads the channels/note from the detail).
    for (const fixture of fixtures.valid) {
      for (const signal of await adapter.normalize(fixture.artifact)) {
        if (signal.consentDetail === undefined) continue;
        expect(signal.consentHint, `fixture "${fixture.name}"`).toBe(
          "practice_attested",
        );
      }
    }
  },

  "every hint carries a valid basis": async (adapter, fixtures) => {
    // Also enforced by the strict schema parse; asserted separately so a
    // basis violation names itself instead of drowning in a zod issue list.
    const validBases = new Set<string>([
      "source_metadata",
      "manual",
      "inferred_text",
      "inferred_related",
    ]);
    for (const fixture of fixtures.valid) {
      for (const signal of await adapter.normalize(fixture.artifact)) {
        for (const hint of [signal.providerHint, signal.locationHint]) {
          if (hint === undefined) continue;
          expect(
            validBases.has(hint.basis),
            `fixture "${fixture.name}": basis "${hint.basis}"`,
          ).toBe(true);
        }
      }
    }
  },
};

/**
 * Registers the shared contract suite for an adapter. Call at the top level
 * of the adapter's Vitest test file.
 */
export function describeAdapterContract(
  adapter: SourceAdapter,
  fixtures: AdapterContractFixtures,
): void {
  if (fixtures.valid.length === 0) {
    throw new Error(
      "describeAdapterContract requires at least one valid fixture — " +
        "an adapter proven against nothing is not proven.",
    );
  }

  describe(`SourceAdapter contract: ${adapter.sourceKind}`, () => {
    for (const [name, check] of Object.entries(adapterContractChecks)) {
      it(name, () => check(adapter, fixtures));
    }
  });
}
