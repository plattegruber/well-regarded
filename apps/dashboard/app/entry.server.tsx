// Adapted from the official React Router v7 Cloudflare template: streams
// the SSR render with web-standard APIs (renderToReadableStream) available
// in workerd, waiting for full content only for bots. Streaming render
// errors go through the request-bound structured logger (issue #64) so they
// carry the requestId minted at the worker edge.
import { createLogger, fallbackRequestId } from "@wellregarded/core";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import type { AppLoadContext, EntryContext } from "react-router";
import { ServerRouter } from "react-router";

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext?: AppLoadContext,
) {
  let shellRendered = false;
  let statusCode = responseStatusCode;
  const userAgent = request.headers.get("user-agent");
  // The fallback only fires outside the worker edge (e.g. a test harness
  // that calls handleRequest without a load context).
  const log =
    loadContext?.logger ??
    createLogger({ worker: "dashboard", requestId: fallbackRequestId() });

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      onError(error: unknown) {
        statusCode = 500;
        // Log streaming rendering errors from inside the shell. Don't log
        // errors encountered during initial shell rendering since they'll
        // reject and get logged in handleDocumentRequest.
        if (shellRendered) {
          log.error("ssr stream rendering error", { error });
        }
      },
    },
  );
  shellRendered = true;

  // Ensure requests from bots and SPA Mode renders wait for all content to
  // load before responding.
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, {
    headers: responseHeaders,
    status: statusCode,
  });
}
