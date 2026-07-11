/**
 * Request-id middleware (issue #64, Epic #24) — MUST be mounted first on
 * the app, before any route group or error handling, so everything
 * downstream (including `app.onError`) logs with the id.
 *
 * Per request it:
 * 1. resolves the id — an inbound `x-request-id` (or `cf-ray`) header is
 *    honored when well-formed, otherwise `crypto.randomUUID()` is minted;
 * 2. publishes `requestId` and a bound `logger` on context
 *    (`c.get("requestId")` / `c.get("logger")`);
 * 3. echoes the id back in the `x-request-id` response header.
 *
 * Handlers that enqueue pipeline work MUST copy `c.get("requestId")` into
 * the message's `requestId` field (see packages/core/src/pipeline) — that
 * hop is what makes one signal's journey greppable end to end.
 */

import {
  createLogger,
  logLevelFor,
  REQUEST_ID_HEADER,
  resolveRequestId,
} from "@wellregarded/core";
import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../bindings";

export function requestId(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const id = resolveRequestId(
      c.req.header(REQUEST_ID_HEADER),
      c.req.header("cf-ray"),
    );
    c.set("requestId", id);
    c.set(
      "logger",
      createLogger({
        worker: "api",
        requestId: id,
        // Route name; per-request context (practiceId) is added downstream
        // via `.child()` once auth resolves it.
        stage: c.req.path,
        level: logLevelFor(
          typeof c.env.ENVIRONMENT === "string" ? c.env.ENVIRONMENT : undefined,
        ),
      }),
    );
    // Set BEFORE next(): headers staged on the context survive into any
    // response built from it — including app.onError's, which runs after an
    // exception unwinds past this middleware.
    c.header(REQUEST_ID_HEADER, id);
    await next();
    // Belt and braces for handlers that return a hand-built Response.
    c.res.headers.set(REQUEST_ID_HEADER, id);
  };
}
