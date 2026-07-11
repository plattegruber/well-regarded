/**
 * Wrangler entrypoint (see `main` in wrangler.jsonc), kept separate from
 * src/app.ts / src/index.ts: workerd only allows handler/DO exports on the
 * entry module, and tests import the app under Node.
 */

import { app } from "./app";
import type { ApiBindings } from "./bindings";

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<ApiBindings>;
