/**
 * Module augmentation wiring the Workers runtime into React Router's loader
 * context. With this in the program, `loader({ context })` exposes
 * `context.cloudflare.env` (the wrangler-generated `Env`) and
 * `context.cloudflare.ctx` (the ExecutionContext) fully typed.
 *
 * Adding a binding (Hyperdrive, KV, ...) requires editing wrangler.jsonc
 * (all three env stanzas!) and running `pnpm --filter @wellregarded/dashboard
 * typegen` to regenerate worker-configuration.d.ts — nothing here changes.
 */
import type { Logger } from "@wellregarded/core";
import "react-router";

declare module "react-router" {
  interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
    /**
     * Trace id resolved at the worker edge (issue #64): honored from
     * inbound `x-request-id`/`cf-ray` or minted, echoed in the response
     * header. Copy it into any queue message this app ever produces.
     */
    requestId: string;
    /**
     * Request-bound structured logger (packages/core/src/log) — the only
     * sanctioned way to log from loaders/actions (Biome bans raw console
     * in apps/*).
     */
    logger: Logger;
  }
}

declare global {
  interface Env {
    /**
     * Deployed commit SHA, injected per-deploy by the CI/CD pipeline
     * (Epic #2) via `wrangler deploy --var GIT_SHA:<sha>`. Not a
     * wrangler.jsonc var, hence declared here instead of generated;
     * absent in local dev (/healthz reports "dev").
     */
    GIT_SHA?: string;
  }
}
