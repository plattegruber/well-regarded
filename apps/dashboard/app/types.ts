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
import "react-router";

declare module "react-router" {
  interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
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
