import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type ApiEnv,
  apiEnvSchema,
  dashboardEnvSchema,
  getEnv,
  jobsEnvSchema,
  patientEnvSchema,
  pipelineEnvSchema,
  resetEnvCache,
} from "./env";

beforeEach(() => {
  resetEnvCache();
});

describe("getEnv", () => {
  it("parses a valid env and returns typed values", () => {
    const env = getEnv(
      {
        ENVIRONMENT: "local",
        CLERK_SECRET_KEY: "sk_test_abc",
        CLERK_PUBLISHABLE_KEY: "pk_test_abc",
      },
      apiEnvSchema,
    );

    // Inferred type flows through the generic.
    const typed: ApiEnv = env;
    expect(typed.ENVIRONMENT).toBe("local");
    expect(typed.CLERK_SECRET_KEY).toBe("sk_test_abc");
    expect(typed.CLERK_PUBLISHABLE_KEY).toBe("pk_test_abc");
  });

  it("accepts envs where optional Clerk keys are absent (pre-#4)", () => {
    const env = getEnv({ ENVIRONMENT: "prod" }, dashboardEnvSchema);
    expect(env.ENVIRONMENT).toBe("prod");
    expect(env.CLERK_SECRET_KEY).toBeUndefined();
  });

  it("validates every worker schema with just ENVIRONMENT", () => {
    for (const schema of [
      pipelineEnvSchema,
      jobsEnvSchema,
      patientEnvSchema,
    ]) {
      expect(getEnv({ ENVIRONMENT: "preview" }, schema).ENVIRONMENT).toBe(
        "preview",
      );
    }
  });

  it("rejects an invalid ENVIRONMENT value", () => {
    expect(() => getEnv({ ENVIRONMENT: "staging" }, jobsEnvSchema)).toThrow(
      /ENVIRONMENT/,
    );
  });

  it("missing var → error names the var, the .dev.vars hint, and the exact wrangler command", () => {
    let message = "";
    try {
      getEnv({}, apiEnvSchema);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("ENVIRONMENT");
    expect(message).toContain("missing");
    expect(message).toContain(
      "workers/api/.dev.vars (see workers/api/.dev.vars.example)",
    );
    expect(message).toContain(
      "wrangler secret put ENVIRONMENT --env <preview|prod>",
    );
  });

  it("two missing/invalid vars → both named in one error", () => {
    let message = "";
    try {
      getEnv(
        { CLERK_SECRET_KEY: "", CLERK_PUBLISHABLE_KEY: "pk_ok" },
        apiEnvSchema,
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("2 problem(s)");
    expect(message).toContain("ENVIRONMENT");
    expect(message).toContain("CLERK_SECRET_KEY");
    expect(message).toContain(
      "wrangler secret put CLERK_SECRET_KEY --env <preview|prod>",
    );
    expect(message).not.toContain("CLERK_PUBLISHABLE_KEY:");
  });

  it("never echoes secret values in error output", () => {
    const secretValue = "sk_live_SUPER_SECRET_VALUE_12345";
    let message = "";
    try {
      // Wrong-typed values: a number for ENVIRONMENT, a secret string where
      // the schema will still fail on other fields.
      getEnv(
        { ENVIRONMENT: secretValue, CLERK_SECRET_KEY: 12345 },
        apiEnvSchema,
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("ENVIRONMENT");
    expect(message).toContain("CLERK_SECRET_KEY");
    expect(message).not.toContain(secretValue);
    expect(message).not.toContain("12345");
  });

  it("uses the right .dev.vars path per worker schema", () => {
    const cases: Array<[z.ZodType, string]> = [
      [pipelineEnvSchema, "workers/pipeline/.dev.vars"],
      [jobsEnvSchema, "workers/jobs/.dev.vars"],
      [dashboardEnvSchema, "apps/dashboard/.dev.vars"],
      [patientEnvSchema, "apps/patient/.dev.vars"],
    ];
    for (const [schema, path] of cases) {
      expect(() => getEnv({}, schema)).toThrow(new RegExp(path));
    }
  });

  it("caches the parse per schema: same raw env parsed once", () => {
    const spy = vi.spyOn(apiEnvSchema, "safeParse");
    const raw = { ENVIRONMENT: "local" };

    const first = getEnv(raw, apiEnvSchema);
    const second = getEnv(raw, apiEnvSchema);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    spy.mockRestore();
  });

  it("does not cache failed parses", () => {
    expect(() => getEnv({}, jobsEnvSchema)).toThrow();
    expect(getEnv({ ENVIRONMENT: "local" }, jobsEnvSchema).ENVIRONMENT).toBe(
      "local",
    );
  });

  it("works with ad-hoc schemas via a generic fallback hint", () => {
    const customSchema = z.object({ SOME_TOKEN: z.string().min(1) });
    expect(() => getEnv({}, customSchema)).toThrow(/<worker>\/\.dev\.vars/);
  });
});
