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
 *
 * Everything Clerk-related stays `.optional()` until the real Clerk
 * application is provisioned — the Epic #4 code (issues #60/#68) ships
 * before any live credentials exist, so the routes that need a var check
 * for it at request time and fail with an actionable message. Once the
 * Clerk app exists, follow docs/secrets.md § "Flipping on real Clerk keys"
 * to set the values, then drop the `.optional()`s.
 */
const clerkEnvSchema = z.object({
  // TODO(#4-auth-epic): make required once the real Clerk app exists (see
  // docs/secrets.md § "Flipping on real Clerk keys").
  CLERK_SECRET_KEY: z.string().min(1).optional(),
  CLERK_PUBLISHABLE_KEY: z.string().min(1).optional(),
});

/**
 * Networkless Clerk session-JWT verification (issue #68) — the staff-auth
 * middleware in workers/api verifies session tokens against this public
 * key with zero Clerk API round-trips.
 */
const clerkJwtVerificationEnvSchema = z.object({
  /**
   * PEM-encoded RSA public key (Clerk dashboard → API keys → "JWKS public
   * key" / JWT verification key).
   */
  // TODO(#4-auth-epic): make required once the real Clerk app exists (see
  // docs/secrets.md § "Flipping on real Clerk keys").
  CLERK_JWKS_PUBLIC_KEY: z.string().min(1).optional(),
  /**
   * Comma-separated origins allowed as the token's `azp` claim (the
   * dashboard origin(s)); blocks session-token reuse from other origins.
   * When unset, `azp` is not checked.
   */
  CLERK_AUTHORIZED_PARTIES: z.string().min(1).optional(),
});

/** Clerk webhook (svix) signature verification (issue #60). */
const clerkWebhookEnvSchema = z.object({
  // TODO(#4-auth-epic): make required once the real Clerk app exists (see
  // docs/secrets.md § "Flipping on real Clerk keys").
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().min(1).optional(),
});

/**
 * PII field-encryption keyring secrets (issue #47), for the workers that
 * read or write `pii.contact_points`. String-presence validation only —
 * structural validation (JSON shape, base64 32-byte keys) is owned by
 * `keyringFromEnv` in `./crypto/fieldEncryption.ts`, which is how these two
 * vars become a `Keyring`.
 */
const piiKeyringEnvSchema = z.object({
  // TODO(#19/#20): make required when the contact write/read paths land in
  // the workers that carry this fragment.
  PII_ENCRYPTION_KEYS: z.string().min(1).optional(),
  PII_HASH_KEY: z.string().min(1).optional(),
});

/**
 * Patient link-token signing secret (issue #70): base64 of >= 32 random
 * bytes (`openssl rand -base64 32`). String-presence validation only —
 * structural validation (base64, length) is owned by the key import in
 * `./patientTokens.ts`. Needed by the patient worker (verify) and by any
 * worker that mints links.
 */
const patientTokenEnvSchema = z.object({
  // TODO(#21): make required when the apps/patient link routes land.
  PATIENT_TOKEN_SECRET: z.string().min(1).optional(),
});

/**
 * AI client configuration (issue #63, Epic #9) — the Anthropic API key and
 * logical→concrete model routing for workers that call `@wellregarded/ai`.
 *
 * `PIPELINE_MODEL` / `DRAFTING_MODEL` are the concrete model ids behind
 * the logical `"pipeline"` / `"drafting"` lanes in `ClassifyOpts.model`;
 * callers never hardcode a model id. The defaults here are the single
 * source of truth for them — workers only set the vars to override (e.g.
 * pinning a previous model after a bad upgrade).
 */
const aiEnvSchema = z.object({
  // TODO(#9-ai-epic): make required once the classify stage (#67) goes
  // live — no live key exists yet, so the AI code paths check for it at
  // call time and fail with an actionable message.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  PIPELINE_MODEL: z.string().min(1).default("claude-haiku-4-5-20251001"),
  DRAFTING_MODEL: z.string().min(1).default("claude-sonnet-5"),
});

/**
 * Google OAuth for the Business Profile integration (issue #118, Epic #7).
 *
 * The three `*_URL` vars exist so local dev and tests point at the fake GBP
 * server (#130) instead of real Google — the defaults are the real hosts,
 * so deployed environments only set the credentials. `business.manage` is
 * the only scope (ADR 0002 §4).
 */
const googleOauthEnvSchema = z.object({
  // TODO(#7-gbp-epic): make CLIENT_ID/SECRET/STATE_SECRET required once the
  // real Google Cloud OAuth client exists (Appendix C of ADR 0002) — until
  // then the connect route checks at request time with an actionable error.
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  /**
   * HMAC key signing the OAuth `state` parameter (anti-CSRF binding of
   * practice + staff + nonce): base64 of >= 32 random bytes
   * (`openssl rand -base64 32`).
   */
  GOOGLE_OAUTH_STATE_SECRET: z.string().min(1).optional(),
  GOOGLE_OAUTH_AUTH_URL: z
    .url()
    .default("https://accounts.google.com/o/oauth2/v2/auth"),
  GOOGLE_OAUTH_TOKEN_URL: z
    .url()
    .default("https://oauth2.googleapis.com/token"),
  GOOGLE_OAUTH_REVOKE_URL: z
    .url()
    .default("https://oauth2.googleapis.com/revoke"),
  /**
   * Base URLs of the two v1 data APIs location discovery calls (#121):
   * Account Management (`listAccounts`) and Business Information
   * (`listLocations`). Local dev and tests point both at the fake GBP
   * server (#130), which serves every surface from one origin.
   */
  GOOGLE_ACCOUNT_MANAGEMENT_URL: z
    .url()
    .default("https://mybusinessaccountmanagement.googleapis.com"),
  GOOGLE_BUSINESS_INFORMATION_URL: z
    .url()
    .default("https://mybusinessbusinessinformation.googleapis.com"),
  /**
   * Public URL of the callback route. Unset = derived from the incoming
   * request's origin (correct for local dev and the deployed worker); set it
   * only when the worker sits behind a rewriting proxy.
   */
  GOOGLE_OAUTH_REDIRECT_URL: z.url().optional(),
  /**
   * Dashboard origin the callback redirects back to
   * (`<origin>/settings?connected=google`). Default matches local dev.
   */
  DASHBOARD_ORIGIN: z.url().default("http://localhost:5173"),
});

/**
 * Cookie-session signing secret for the dashboard (flash messages, #141):
 * any long random string (`openssl rand -base64 32`).
 */
const sessionEnvSchema = z.object({
  // Optional in local dev (the flash helper falls back to an insecure
  // dev-only secret); deployed environments must set it — the helper
  // throws otherwise.
  SESSION_SECRET: z.string().min(1).optional(),
});

// One schema per worker. Compose from the shared fragments above rather than
// repeating fields. Workers that bind Hyperdrive validate nothing DB-related:
// the connection arrives through the binding (typed by `Env`, see header).
export const apiEnvSchema = baseEnvSchema
  .extend(clerkEnvSchema.shape)
  .extend(clerkJwtVerificationEnvSchema.shape)
  .extend(clerkWebhookEnvSchema.shape)
  .extend(piiKeyringEnvSchema.shape)
  .extend(googleOauthEnvSchema.shape);
export const pipelineEnvSchema = baseEnvSchema
  .extend(piiKeyringEnvSchema.shape)
  .extend(aiEnvSchema.shape);
export const jobsEnvSchema = baseEnvSchema.extend(piiKeyringEnvSchema.shape);
export const dashboardEnvSchema = baseEnvSchema
  .extend(clerkEnvSchema.shape)
  .extend(sessionEnvSchema.shape);
export const patientEnvSchema = baseEnvSchema.extend(
  patientTokenEnvSchema.shape,
);

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
