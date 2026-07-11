/**
 * Workers fetch handler for the dashboard (see `main` in wrangler.jsonc).
 *
 * `getLoadContext` pattern from the official React Router v7 Cloudflare
 * template: the object passed to `requestHandler` becomes `context` in every
 * loader/action, typed by the `AppLoadContext` augmentation in app/types.ts.
 *
 * Request-id edge (issue #64): the dashboard worker is this app's edge, so
 * the id is resolved HERE (inbound `x-request-id`/`cf-ray` honored, else
 * minted), handed to every loader/action as `context.requestId` /
 * `context.logger`, and echoed back in the `x-request-id` response header.
 */
import {
  createLogger,
  logLevelFor,
  REQUEST_ID_HEADER,
  resolveRequestId,
} from "@wellregarded/core";
import { createRequestHandler } from "react-router";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    const requestId = resolveRequestId(
      request.headers.get(REQUEST_ID_HEADER),
      request.headers.get("cf-ray"),
    );
    const logger = createLogger({
      worker: "dashboard",
      requestId,
      stage: new URL(request.url).pathname,
      level: logLevelFor(env.ENVIRONMENT),
    });
    const response = await requestHandler(request, {
      cloudflare: { env, ctx },
      requestId,
      logger,
    });
    // Streamed SSR responses can carry immutable headers — rewrap.
    const traced = new Response(response.body, response);
    traced.headers.set(REQUEST_ID_HEADER, requestId);
    return traced;
  },
} satisfies ExportedHandler<Env>;
