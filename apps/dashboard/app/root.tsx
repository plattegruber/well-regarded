// Root layout: loads the design-system foundation (#115) — token CSS and
// the webfonts — plus the flash-message loader (#141): actions set a flash
// via setFlash, the loader here reads-and-clears it, and the shell's
// <Toaster /> renders it after the redirect.
import {
  data,
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import { Overline } from "~/components/shell/page-header";
import { buttonVariants } from "~/components/ui/button";
import { readFlash } from "~/lib/flash.server";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/root";

import "./app.css";

export const links: Route.LinksFunction = () => [
  // Google-hosted substitutes per design/design-system/tokens/fonts.css —
  // no brand font binaries exist. Self-hosting (for privacy and offline
  // dev) is a flagged follow-up.
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&family=Space+Grotesk:wght@400;500;600;700&display=swap",
  },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { flash, headers } = await readFlash(context.cloudflare.env, request);
  // headers carries the clearing Set-Cookie; the `headers` export below
  // forwards it onto the document response.
  return data({ flash }, headers ? { headers } : undefined);
}

// Routes that don't export `headers` inherit the deepest export in the
// matched tree — this one — so the flash-clearing Set-Cookie reaches the
// browser on document requests.
export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * Root error boundary (#141) — an error page is still our product, so it
 * keeps the tokens and the voice. 404s teach the way back; unexpected
 * errors apologize calmly and show the stack only in dev.
 *
 * The way home is a plain anchor on purpose: after an error, a full
 * document reload is the safest recovery, and the boundary must not depend
 * on router state that may itself have failed.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let overline = "Error";
  let title = "Something went wrong";
  let body =
    "An unexpected error occurred. Your data is fine. Try again, or come back in a moment.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    overline = `HTTP ${error.status}`;
    if (error.status === 404) {
      title = "This page doesn't exist";
      body =
        "The address may be mistyped, or the page may have moved. Today is the place to start.";
    } else {
      body = error.statusText || body;
    }
  } else if (import.meta.env.DEV && error instanceof Error) {
    body = error.message;
    stack = error.stack;
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-page px-6 font-sans text-ink-900">
      <div className="w-full max-w-140">
        <Overline className="mb-2.5">{overline}</Overline>
        <h1 className="m-0 font-display text-h1 font-medium tracking-display text-ink-900">
          {title}
        </h1>
        <p className="mt-2 mb-0 text-body text-gray-600">{body}</p>
        <a
          href="/today"
          className={cn(
            buttonVariants({ variant: "secondary", size: "sm" }),
            "mt-6 no-underline",
          )}
        >
          Go to today
        </a>
        {stack && (
          <pre className="mt-8 max-h-80 overflow-auto border border-hairline bg-surface-sunken p-4 font-mono text-label text-gray-600">
            <code>{stack}</code>
          </pre>
        )}
      </div>
    </main>
  );
}
