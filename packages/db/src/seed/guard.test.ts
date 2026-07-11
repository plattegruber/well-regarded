import { describe, expect, it } from "vitest";

import { assertSeedTargetAllowed, SeedGuardError } from "./guard.js";

const LOCAL_URL =
  "postgres://wellregarded:wellregarded@localhost:54322/wellregarded";
const REMOTE_URL = "postgres://user:pass@db.example.com:5432/wellregarded";

describe("assertSeedTargetAllowed", () => {
  it("allows a localhost DATABASE_URL", () => {
    expect(() =>
      assertSeedTargetAllowed({
        databaseUrl: LOCAL_URL,
        environment: "local",
        force: false,
      }),
    ).not.toThrow();
  });

  it("allows 127.0.0.1 and [::1]", () => {
    for (const host of ["127.0.0.1", "[::1]"]) {
      expect(() =>
        assertSeedTargetAllowed({
          databaseUrl: `postgres://u:p@${host}:5432/db`,
          environment: undefined,
          force: false,
        }),
      ).not.toThrow();
    }
  });

  it("refuses a non-local DATABASE_URL without --force", () => {
    expect(() =>
      assertSeedTargetAllowed({
        databaseUrl: REMOTE_URL,
        environment: undefined,
        force: false,
      }),
    ).toThrow(SeedGuardError);
  });

  it("allows a non-local DATABASE_URL with --force", () => {
    expect(() =>
      assertSeedTargetAllowed({
        databaseUrl: REMOTE_URL,
        environment: "preview",
        force: true,
      }),
    ).not.toThrow();
  });

  it("refuses ENVIRONMENT=prod even with --force and a local URL", () => {
    expect(() =>
      assertSeedTargetAllowed({
        databaseUrl: LOCAL_URL,
        environment: "prod",
        force: true,
      }),
    ).toThrow(/ENVIRONMENT=prod/);
  });

  it("refuses an unparseable DATABASE_URL", () => {
    expect(() =>
      assertSeedTargetAllowed({
        databaseUrl: "not a url",
        environment: undefined,
        force: false,
      }),
    ).toThrow(SeedGuardError);
  });
});
