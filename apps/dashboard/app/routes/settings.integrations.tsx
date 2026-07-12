// Settings → Integrations (#121): the Google Business Profile connection
// card. Shows the connection state (#118's status payload, read through
// the same DB row the API's status endpoint serves — SSR calls to the API
// worker need the Clerk session Epic #4 wires up; see TODO(#59) below),
// the discovered/mapped location counts, and the entries into the two
// flows: Connect (a full-page navigation to the API worker's OAuth route)
// and the mapping screen.
//
// The OAuth callback redirects back here with `?connected=google` or
// `?error=<code>` — rendered as a banner, not a toast, because the message
// must survive being landed on from another origin (no flash cookie was
// set on our side).
import { parseGoogleConnectionMetadata } from "@wellregarded/core";
import { getSourceConnection } from "@wellregarded/db";
import { Link, useSearchParams } from "react-router";

import { PageHeader } from "~/components/shell/page-header";
import { Badge } from "~/components/ui/badge";
import { buttonVariants } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { withRequestDb } from "~/lib/db.server";
import { requirePracticeContext } from "~/lib/practice-context.server";
import type { Route } from "./+types/settings.integrations";

export function meta() {
  return [{ title: "Integrations · Well Regarded" }];
}

/** The env slice this page needs (same pattern as settings.imports.tsx). */
export interface IntegrationsEnv {
  API_URL?: string;
}

/**
 * Callback error codes (`GoogleCallbackError`, workers/api) → calm,
 * sentence-case copy. Unknown codes fall back to a generic line — the API
 * may add codes, never rename them.
 */
const CALLBACK_ERROR_COPY: Record<string, string> = {
  google_access_denied:
    "Google access was declined. Connect again and allow access to your Business Profile.",
  google_no_refresh_token:
    "Google didn't grant offline access. Connect again and approve the consent screen.",
  google_exchange_failed:
    "Google couldn't complete the connection. Try again in a moment.",
};

export function callbackErrorMessage(code: string): string {
  return (
    CALLBACK_ERROR_COPY[code] ??
    "The Google connection didn't complete. Try connecting again."
  );
}

export async function loader({ context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as IntegrationsEnv;
  const apiUrl = env.API_URL ?? "http://localhost:8787";
  return withRequestDb(context, async (db) => {
    // TODO(#59): requirePracticeContext is the auth seam — see its module doc.
    const ctx = await requirePracticeContext(db);
    const connection = await getSourceConnection(db, ctx.practiceId, "google");
    if (!connection || connection.status === "disconnected") {
      return { apiUrl, google: null };
    }
    const { googleLocations, locationMappings } = parseGoogleConnectionMetadata(
      connection.metadata,
    );
    return {
      apiUrl,
      google: {
        status: connection.status,
        lastSyncAt: connection.lastSyncAt?.toISOString() ?? null,
        discovered: googleLocations.length,
        unverified: googleLocations.filter(
          (l) => l.verificationState === "unverified",
        ).length,
        mapped: locationMappings.filter((m) => m.locationId !== null).length,
        skipped: locationMappings.filter((m) => m.locationId === null).length,
      },
    };
  });
}

function StatusBadge({ status }: { status: "active" | "needs_reauth" }) {
  return status === "active" ? (
    <Badge tone="positive">Connected</Badge>
  ) : (
    <Badge tone="caution">Reconnect needed</Badge>
  );
}

export default function Integrations({ loaderData }: Route.ComponentProps) {
  const { apiUrl, google } = loaderData;
  const [searchParams] = useSearchParams();
  const connected = searchParams.get("connected") === "google";
  const errorCode = searchParams.get("error");
  const connectHref = `${apiUrl}/api/integrations/google/connect`;

  return (
    <>
      <PageHeader
        overline="Settings · integrations"
        title="Integrations"
        description="Feedback sources connected to this practice."
      />
      <div className="flex max-w-130 flex-col gap-3.5">
        {connected && (
          <Card sunken>
            <p className="m-0 text-small text-ink-900">
              Google Business Profile is connected.{" "}
              <Link
                to="/settings/integrations/google/locations"
                className="underline"
              >
                Map your locations
              </Link>{" "}
              to start importing reviews.
            </p>
          </Card>
        )}
        {errorCode && (
          <Card sunken>
            <p className="m-0 text-small text-red-700" role="alert">
              {callbackErrorMessage(errorCode)}
            </p>
          </Card>
        )}

        <Card
          title="Google Business Profile"
          action={google ? <StatusBadge status={google.status} /> : undefined}
        >
          {google === null ? (
            <>
              <p className="m-0 mb-3.5 text-small text-gray-600">
                Connect the Google account that manages your Business Profile to
                import reviews and publish replies.
              </p>
              {/* A full-page navigation, not a fetch: the OAuth dance is a
                  browser redirect chain through Google's consent screen. */}
              <a
                href={connectHref}
                className={buttonVariants({ variant: "primary", size: "sm" })}
              >
                Connect Google
              </a>
            </>
          ) : (
            <>
              <p className="m-0 mb-3.5 text-small text-gray-600">
                {google.discovered === 0
                  ? "No Google locations discovered yet — open the mapping screen to refresh."
                  : `${google.discovered} Google ${
                      google.discovered === 1 ? "location" : "locations"
                    } found · ${google.mapped} mapped · ${google.skipped} skipped` +
                    (google.unverified > 0
                      ? ` · ${google.unverified} unverified`
                      : "")}
              </p>
              {google.status === "needs_reauth" && (
                <p className="m-0 mb-3.5 text-small text-gray-600">
                  Google stopped accepting our access. Reconnect to resume
                  importing reviews — your location mapping is kept.
                </p>
              )}
              <div className="flex items-center gap-3">
                {google.status === "needs_reauth" ? (
                  <a
                    href={connectHref}
                    className={buttonVariants({
                      variant: "primary",
                      size: "sm",
                    })}
                  >
                    Reconnect Google
                  </a>
                ) : (
                  <Link
                    to="/settings/integrations/google/locations"
                    className={buttonVariants({
                      variant: "secondary",
                      size: "sm",
                    })}
                  >
                    Map locations
                  </Link>
                )}
              </div>
            </>
          )}
        </Card>
        <p className="m-0 text-small text-gray-500">
          <Link to="/settings" className="text-ink-900 underline">
            Back to settings
          </Link>
        </p>
      </div>
    </>
  );
}
