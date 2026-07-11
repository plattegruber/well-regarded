import { afterEach, describe, expect, it } from "vitest";

import { csvFixtureAdapter } from "./contract/csvFixtureAdapter.js";
import { fixtureAdapter } from "./contract/fixtureAdapter.js";
import {
  getAdapter,
  registerAdapter,
  resetAdapterRegistry,
} from "./registry.js";

afterEach(() => {
  resetAdapterRegistry();
});

describe("adapter registry", () => {
  it("resolves the default manual adapter by kind", () => {
    expect(getAdapter("manual")).toBe(fixtureAdapter);
  });

  it("returns undefined for a kind with no adapter", () => {
    expect(getAdapter("google")).toBeUndefined();
  });

  it("registers additional adapters and resolves each by its own kind", () => {
    registerAdapter(csvFixtureAdapter);
    expect(getAdapter("csv_import")).toBe(csvFixtureAdapter);
    expect(getAdapter("manual")).toBe(fixtureAdapter);
  });

  it("throws on a duplicate kind — two adapters for one kind is a wiring bug", () => {
    registerAdapter(csvFixtureAdapter);
    expect(() => registerAdapter(csvFixtureAdapter)).toThrow(
      "already registered",
    );
  });

  it("resetAdapterRegistry drops test registrations", () => {
    registerAdapter(csvFixtureAdapter);
    resetAdapterRegistry();
    expect(getAdapter("csv_import")).toBeUndefined();
  });
});
