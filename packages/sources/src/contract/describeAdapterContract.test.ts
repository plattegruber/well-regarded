/**
 * Meta-tests: deliberately broken adapters must FAIL the contract suite.
 * The individual checks are exported (`adapterContractChecks`) precisely so
 * these tests can assert rejection without fighting vitest's `describe`
 * registration.
 */

import { describe, expect, it } from "vitest";

import {
  type AdapterContractFixtures,
  adapterContractChecks,
  describeAdapterContract,
} from "./describeAdapterContract.js";
import {
  emptyFixtureArtifact,
  fixtureAdapter,
  fixtureArtifact,
} from "./fixtureAdapter.js";
import type { NormalizedSignal } from "./normalizedSignal.js";
import type { SourceAdapter } from "./sourceAdapter.js";

const fixtures: AdapterContractFixtures = {
  valid: [
    { name: "three entries", artifact: fixtureArtifact, expectedCount: 3 },
  ],
  empty: emptyFixtureArtifact,
};

const check = (name: keyof typeof adapterContractChecks) => {
  const fn = adapterContractChecks[name];
  if (fn === undefined) throw new Error(`no such contract check: ${name}`);
  return fn;
};

describe("adapterContractChecks (meta: broken adapters fail)", () => {
  it("catches unknown keys leaking through normalize", async () => {
    const leaky: SourceAdapter = {
      ...fixtureAdapter,
      normalize: async (artifact) =>
        (await fixtureAdapter.normalize(artifact)).map((signal) => ({
          ...signal,
          sentiment: "positive", // not a NormalizedSignal field
        })) as unknown as NormalizedSignal[],
    };
    await expect(
      check("every signal passes the strict NormalizedSignal schema")(
        leaky,
        fixtures,
      ),
    ).rejects.toThrow();
  });

  it("catches a wrong signal count", async () => {
    await expect(
      check("produces the expected number of signals per fixture")(
        fixtureAdapter,
        {
          ...fixtures,
          valid: [
            {
              name: "three entries",
              artifact: fixtureArtifact,
              expectedCount: 99,
            },
          ],
        },
      ),
    ).rejects.toThrow();
  });

  it("catches a sourceKind mismatch", async () => {
    const wrongKind: SourceAdapter = {
      ...fixtureAdapter,
      sourceKind: "google", // signals still say "manual"
    };
    await expect(
      check("every signal's sourceKind matches the adapter's")(
        wrongKind,
        fixtures,
      ),
    ).rejects.toThrow();
  });

  it("catches unstable sourceIds", async () => {
    let run = 0;
    const unstable: SourceAdapter = {
      ...fixtureAdapter,
      normalize: async (artifact) => {
        run += 1;
        return (await fixtureAdapter.normalize(artifact)).map((signal) => ({
          ...signal,
          sourceId: `${signal.sourceId}-${run}`,
        }));
      },
    };
    await expect(
      check("sourceIds are stable across repeated normalization")(
        unstable,
        fixtures,
      ),
    ).rejects.toThrow();
  });

  it("catches throwing on a degenerate artifact", async () => {
    const brittle: SourceAdapter = {
      ...fixtureAdapter,
      normalize: async (artifact) => {
        const signals = await fixtureAdapter.normalize(artifact);
        if (signals.length === 0) throw new Error("empty batch!");
        return signals;
      },
    };
    await expect(
      check("a degenerate artifact yields [] without throwing")(
        brittle,
        fixtures,
      ),
    ).rejects.toThrow();
  });

  it("catches a patientHint from an adapter without supportsIdentity", async () => {
    const identityLeak: SourceAdapter = {
      ...fixtureAdapter, // supportsIdentity: false
      normalize: async (artifact) =>
        (await fixtureAdapter.normalize(artifact)).map((signal) => ({
          ...signal,
          patientHint: { name: "Leaked Name" },
        })),
    };
    await expect(
      check("emits patientHint only when supportsIdentity")(
        identityLeak,
        fixtures,
      ),
    ).rejects.toThrow();
  });

  it("catches a consentHint from an adapter without supportsConsent", async () => {
    const consentLeak: SourceAdapter = {
      ...fixtureAdapter,
      capabilities: { ...fixtureAdapter.capabilities, supportsConsent: false },
    };
    // fixtureArtifact entries carry attested flags, so hints are emitted.
    await expect(
      check("emits consentHint only when supportsConsent")(
        consentLeak,
        fixtures,
      ),
    ).rejects.toThrow();
  });

  it("catches an invalid hint basis", async () => {
    const badBasis: SourceAdapter = {
      ...fixtureAdapter,
      normalize: async (artifact) =>
        (await fixtureAdapter.normalize(artifact)).map((signal) => ({
          ...signal,
          providerHint: {
            text: "Dr. Patel",
            basis: "gut_feeling" as never,
          },
        })),
    };
    await expect(
      check("every hint carries a valid basis")(badBasis, fixtures),
    ).rejects.toThrow();
  });
});

describe("describeAdapterContract", () => {
  it("refuses an empty fixture set", () => {
    expect(() =>
      describeAdapterContract(fixtureAdapter, {
        valid: [],
        empty: emptyFixtureArtifact,
      }),
    ).toThrow(/at least one valid fixture/);
  });

  it("all checks pass for the well-behaved reference adapter", async () => {
    for (const [name, checkFn] of Object.entries(adapterContractChecks)) {
      await expect(checkFn(fixtureAdapter, fixtures), name).resolves.toBe(
        undefined,
      );
    }
  });
});
