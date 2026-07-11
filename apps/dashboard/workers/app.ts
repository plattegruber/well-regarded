/**
 * Workers fetch handler for the dashboard (see `main` in wrangler.jsonc).
 *
 * `getLoadContext` pattern from the official React Router v7 Cloudflare
 * template: the object passed to `requestHandler` becomes `context` in every
 * loader/action, typed by the `AppLoadContext` augmentation in app/types.ts.
 */
import { createRequestHandler } from "react-router";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
} satisfies ExportedHandler<Env>;
