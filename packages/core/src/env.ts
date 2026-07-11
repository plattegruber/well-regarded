/**
 * Zod-validated environment configuration for every worker.
 *
 * Ownership split
 * ---------------
 * - **zod (this file) owns string vars and secrets.** Everything that arrives
 *   as a plain string on `env` — values from `.dev.vars` locally, and from
 *   `vars` in `wrangler.jsonc` or `wrangler secret put` in deployed
 *   environments — is validated here, once per isolate, on first touch.
 * - **The `wrangler types`-generated `Env` interface owns bindings.**
 *   Cloudflare resource bindings (Queues, KV, R2, Hyperdrive, Durable
 *   Objects) are live objects injected by the runtime. They are typed by the
 *   generated `Env` interface and are deliberately *not* described by these
 *   schemas — zod would only see an opaque object and could not meaningfully
 *   validate it.
 *
 * Usage: call `getEnv(env, apiEnvSchema)` (or the schema for your worker) at
 * the top of your `fetch`/`queue` handler, before any other work. Workers
 * have no boot phase, so first-touch validation with per-isolate caching is
 * the idiom for "fail fast at startup": a misconfigured deploy fails on the
 * first request with an actionable message instead of a random `TypeError`
 * deep in a handler.
 *
 * This module must stay dependency-free beyond zod so `apps/patient` can
 * import it without dragging anything else in.
 *
 * `docs/secrets.md` documents the naming convention and the full table of
 * known vars. The `.dev.vars.example` files must stay in sync with the
 * schemas in this file.
 */

import { z } from "zod";

/** Fields shared by every worker. */
const baseEnvSchema = z.object({
  ENVIRONMENT: z.enum(["local", "preview", "prod"]),
});

/**
 * Clerk credentials, shared by the workers that terminate authenticated
 * user traffic (api, dashboard).
 */
const clerkEnvSchema = z.object({
  // TODO(#4-auth-epic): make required — Epic #4 flips these to required when
  // Clerk lands.
  CLERK_SECRET_KEY: z.string().min(1).optional(),
  CLERK_PUBLISHABLE_KEY: z.string().min(1).optional(),
});

// One schema per worker. Compose from the shared fragments above rather than
// repeating fields. Workers that bind Hyperdrive validate nothing DB-related:
// the connection arrives through the binding (typed by `Env`, see header).
export const apiEnvSchema = baseEnvSchema.extend(clerkEnvSchema.shape);
export const pipelineEnvSchema = baseEnvSchema.extend({});
export const jobsEnvSchema = baseEnvSchema.extend({});
export const dashboardEnvSchema = baseEnvSchema.extend(clerkEnvSchema.shape);
export const patientEnvSchema = baseEnvSchema.extend({});

export type BaseEnv = z.infer<typeof baseEnvSchema>;
export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type PipelineEnv = z.infer<typeof pipelineEnvSchema>;
export type JobsEnv = z.infer<typeof jobsEnvSchema>;
export type DashboardEnv = z.infer<typeof dashboardEnvSchema>;
export type PatientEnv = z.infer<typeof patientEnvSchema>;

/**
 * Where each worker keeps its local `.dev.vars`, used to render actionable
 * fix instructions in validation errors. Unknown (e.g. test-only) schemas
 * fall back to a generic `<worker>` placeholder.
 */
const devVarsPathBySchema = new Map<z.ZodType, string>([
  [apiEnvSchema, "workers/api"],
  [pipelineEnvSchema, "workers/pipeline"],
  [jobsEnvSchema, "workers/jobs"],
  [dashboardEnvSchema, "apps/dashboard"],
  [patientEnvSchema, "apps/patient"],
]);

/**
 * Per-isolate cache of parsed envs, keyed by schema. Module state resets on
 * isolate recycle, which is exactly the lifetime we want: hot-path handlers
 * can call `getEnv` on every request for free.
 */
const envCache = new WeakMap<z.ZodType, unknown>();

/** Test helper: clears the per-isolate parse cache. */
export function resetEnvCache(): void {
  for (const schema of devVarsPathBySchema.keys()) {
    envCache.delete(schema);
  }
}

/**
 * Describes what a zod issue expected, WITHOUT ever echoing the received
 * value — env vars are secrets, so error messages name variables only.
 */
function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return issue.input === undefined
        ? `missing — expected ${issue.expected}`
        : `invalid — expected ${issue.expected}`;
    case "invalid_value": {
      const options = issue.values.map((v) => JSON.stringify(v)).join(" | ");
      return issue.input === undefined
        ? `missing — expected one of ${options}`
        : `invalid — expected one of ${options}`;
    }
    case "too_small":
      return issue.origin === "string"
        ? "invalid — expected a non-empty string"
        : `invalid — too small (minimum: ${String(issue.minimum)})`;
    default:
      return `invalid (${issue.code ?? "unknown"})`;
  }
}

function buildErrorMessage(error: z.ZodError, schema: z.ZodType): string {
  const devVarsDir = devVarsPathBySchema.get(schema) ?? "<worker>";
  const names: string[] = [];
  const lines: string[] = [];
  for (const issue of error.issues) {
    const name = issue.path.map(String).join(".") || "(root)";
    names.push(name);
    lines.push(`  - ${name}: ${describeIssue(issue)}`);
  }
  const fixes = names.map(
    (name) => `  wrangler secret put ${name} --env <preview|prod>`,
  );
  return [
    `Invalid environment: ${names.length} problem(s) found:`,
    ...lines,
    "",
    `Fix for local dev: add the variable(s) to ${devVarsDir}/.dev.vars (see ${devVarsDir}/.dev.vars.example).`,
    "Fix for deployed environments: set non-secret vars in `vars` in wrangler.jsonc, or for secrets run:",
    ...fixes,
    "",
    "Schemas live in packages/core/src/env.ts. See docs/secrets.md for the full variable table.",
  ].join("\n");
}

/**
 * Validates `rawEnv` against `schema` and returns the parsed, fully typed
 * env object.
 *
 * - Success is cached per isolate (keyed by schema), so hot-path handlers
 *   can call this on every request for free.
 * - Failure throws an `Error` whose message lists **every** missing/invalid
 *   var by name, what was expected, and how to fix it per environment.
 *   Values are never echoed — names only.
 */
export function getEnv<S extends z.ZodType>(
  rawEnv: unknown,
  schema: S,
): z.infer<S> {
  if (envCache.has(schema)) {
    return envCache.get(schema) as z.infer<S>;
  }
  const result = schema.safeParse(rawEnv);
  if (!result.success) {
    throw new Error(buildErrorMessage(result.error, schema));
  }
  envCache.set(schema, result.data);
  return result.data as z.infer<S>;
}
