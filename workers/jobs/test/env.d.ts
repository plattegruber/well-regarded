import type { JobsBindings } from "../src/bindings";

declare module "cloudflare:test" {
  // `env` in workers-pool tests carries the bindings from wrangler.jsonc's
  // top-level (local) block — the same shape the worker sees.
  interface ProvidedEnv extends JobsBindings {}
}
