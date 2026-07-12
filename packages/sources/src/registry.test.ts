import { afterEach, describe, expect, it } from "vitest";

import type { SourceAdapter } from "./contract/sourceAdapter.js";
import { csvImportAdapter } from "./csv/adapter.js";
import { googleReviewsAdapter } from "./google/adapter.js";
import { manualEntryAdapter } from "./manual/adapter.js";
import {
  getAdapter,
  registerAdapter,
  resetAdapterRegistry,
} from "./registry.js";

/** A minimal extra adapter for a kind with no default registration. */
const emailStubAdapter: SourceAdapter = {
  sourceKind: "email",
  capabilities: {
    supportsIdentity: false,
    supportsConsent: false,
    supportsPolling: false,
  },
  normalize: () => Promise.resolve([]),
};

afterEach(() => {
  resetAdapterRegistry();
});

describe("adapter registry", () => {
  it("resolves the default manual-entry adapter by kind (#138)", () => {
    expect(getAdapter("manual")).toBe(manualEntryAdapter);
  });

  it("resolves the default google adapter by kind (#125)", () => {
    expect(getAdapter("google")).toBe(googleReviewsAdapter);
  });

  it("resolves the default csv import adapter by kind (#135)", () => {
    expect(getAdapter("csv_import")).toBe(csvImportAdapter);
  });

  it("returns undefined for a kind with no adapter", () => {
    expect(getAdapter("opendental")).toBeUndefined();
  });

  it("registers additional adapters and resolves each by its own kind", () => {
    registerAdapter(emailStubAdapter);
    expect(getAdapter("email")).toBe(emailStubAdapter);
    expect(getAdapter("manual")).toBe(manualEntryAdapter);
  });

  it("throws on a duplicate kind — two adapters for one kind is a wiring bug", () => {
    registerAdapter(emailStubAdapter);
    expect(() => registerAdapter(emailStubAdapter)).toThrow(
      "already registered",
    );
  });

  it("resetAdapterRegistry drops test registrations", () => {
    registerAdapter(emailStubAdapter);
    resetAdapterRegistry();
    expect(getAdapter("email")).toBeUndefined();
  });
});
