// Settings → Integrations → Google locations (#121): map what Google
// exposes onto OUR locations. Everything downstream — polling (#123),
// signal attribution, Presence — hangs off this mapping; unmapped and
// unverified locations are deliberately excluded from polling.
//
// Per discovered Google location the table offers: a select of our
// locations (pre-selected on an unambiguous name/address match — simple
// normalized comparison, no AI), a create-new-location option with inline
// prefilled fields, and an explicit "Don't import" choice (persisted, so
// "deliberately skipped" reads differently from "new/undecided").
// Unverified listings show a badge with the why and can't be mapped.
//
// The save action follows the five-step recipe (docs/frontend-conventions.md)
// but reads dynamic per-row field names (`decision:<googleLocationName>`),
// so it interprets the form data directly instead of `parseForm` — the
// documented seam for the first genuinely dynamic form. Validation and
// auditing live in `saveGoogleLocationMappings` (@wellregarded/db), shared
// verbatim with the API worker's PUT /integrations/google/mappings.
import {
  can,
  type GoogleDiscoveredLocation,
  parseGoogleConnectionMetadata,
  splitFormattedAddress,
  suggestLocationId,
} from "@wellregarded/core";
import {
  type GoogleMappingEntry,
  getSourceConnection,
  listPracticeLocations,
  saveGoogleLocationMappings,
} from "@wellregarded/db";
import { useMemo, useState } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";

import { PageHeader } from "~/components/shell/page-header";
import { Badge } from "~/components/ui/badge";
import { Button, buttonVariants } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { withRequestDb } from "~/lib/db.server";
import { setFlash } from "~/lib/flash.server";
import type { FieldErrors } from "~/lib/forms.server";
import { requirePracticeContext } from "~/lib/practice-context.server";
import type { Route } from "./+types/settings.integrations.google.locations";

export function meta() {
  return [{ title: "Google locations · Well Regarded" }];
}

/** The env slice this page needs (same pattern as settings.imports.tsx). */
export interface GoogleLocationsEnv {
  API_URL?: string;
  ENVIRONMENT?: string;
  SESSION_SECRET?: string;
}

const SELF = "/settings/integrations/google/locations";

/** One table row, loader-shaped: snapshot entry + current/suggested decision. */
export interface MappingRow {
  googleLocationName: string;
  title: string;
  address: string;
  accountDisplayName: string;
  verified: boolean;
  /** Select value: "" (undecided) | "skip" | `map:<locationId>` | "create". */
  initialValue: string;
  /** True when `initialValue` is an auto-suggestion, not a saved decision. */
  suggested: boolean;
  createDefaults: {
    name: string;
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
  };
}

function toRow(
  location: GoogleDiscoveredLocation,
  current: string | null | undefined, // locationId | null (skip) | undefined
  candidates: Array<{ id: string; name: string; addressLine1: string | null }>,
): MappingRow {
  const verified = location.verificationState === "verified";
  let initialValue = "";
  let suggested = false;
  if (current === null) {
    initialValue = "skip";
  } else if (current !== undefined) {
    initialValue = `map:${current}`;
  } else if (verified) {
    const suggestion = suggestLocationId(location, candidates);
    if (suggestion) {
      initialValue = `map:${suggestion}`;
      suggested = true;
    }
  }
  const split = splitFormattedAddress(location.address);
  return {
    googleLocationName: location.googleLocationName,
    title: location.title,
    address: location.address,
    accountDisplayName: location.accountDisplayName,
    verified,
    initialValue,
    suggested,
    createDefaults: {
      name: location.title,
      addressLine1: split.addressLine1 ?? "",
      city: split.city ?? "",
      state: split.state ?? "",
      postalCode: split.postalCode ?? "",
    },
  };
}

export async function loader({ context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as GoogleLocationsEnv;
  const apiUrl = env.API_URL ?? "http://localhost:8787";
  return withRequestDb(context, async (db) => {
    // TODO(#59): requirePracticeContext is the auth seam — see its module doc.
    const ctx = await requirePracticeContext(db);
    const connection = await getSourceConnection(db, ctx.practiceId, "google");
    if (!connection || connection.status === "disconnected") {
      return { connected: false as const, apiUrl };
    }
    const { googleLocations, locationMappings } = parseGoogleConnectionMetadata(
      connection.metadata,
    );
    const ourLocations = await listPracticeLocations(db, ctx.practiceId);
    const candidates = ourLocations.map((l) => ({
      id: l.id,
      name: l.name,
      addressLine1: l.addressLine1,
    }));
    const decisionByName = new Map(
      locationMappings.map((m) => [m.googleLocationName, m.locationId]),
    );
    return {
      connected: true as const,
      apiUrl,
      needsReauth: connection.status === "needs_reauth",
      // Multi-account (agency/owner) setups get the account column.
      multiAccount:
        new Set(googleLocations.map((l) => l.accountDisplayName)).size > 1,
      rows: googleLocations.map((l) =>
        toRow(l, decisionByName.get(l.googleLocationName), candidates),
      ),
      locations: ourLocations.map((l) => ({ id: l.id, name: l.name })),
    };
  });
}

/** `saveGoogleLocationMappings` issues → per-row field errors. */
function issuesToFieldErrors(
  issues: Array<{ googleLocationName: string; message: string }>,
): FieldErrors {
  const fieldErrors: FieldErrors = {};
  for (const issue of issues) {
    const key = `decision:${issue.googleLocationName}`;
    fieldErrors[key] = [...(fieldErrors[key] ?? []), issue.message];
  }
  return fieldErrors;
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as GoogleLocationsEnv;
  const formData = await request.formData();

  if (formData.get("intent") === "refresh") {
    // Discovery must run in the API worker — only it holds the Google
    // credentials. Forward the caller's session cookie for the SSR call.
    // TODO(#59): until Clerk auth lands, local dev has no session cookie,
    // so this surfaces the failure message instead of refreshing.
    const apiUrl = env.API_URL ?? "http://localhost:8787";
    let res: Response | null = null;
    try {
      res = await fetch(
        `${apiUrl}/api/integrations/google/locations/discover`,
        {
          method: "POST",
          headers: { cookie: request.headers.get("cookie") ?? "" },
        },
      );
    } catch {
      res = null;
    }
    if (res?.status === 409) {
      return data(
        {
          refreshError:
            "Google stopped accepting our access — reconnect from the integrations page, then refresh again.",
        },
        { status: 409 },
      );
    }
    if (!res?.ok) {
      return data(
        {
          refreshError:
            "Couldn't refresh locations from Google. Try again in a moment.",
        },
        { status: 502 },
      );
    }
    return redirect(SELF, {
      headers: await setFlash(env, {
        tone: "positive",
        message: "Locations refreshed",
      }),
    });
  }

  // -- Save (the five-step action recipe).
  return withRequestDb(context, async (db) => {
    // 1. Permission check — in the action, always.
    const ctx = await requirePracticeContext(db);
    if (!can(ctx.actor, "manage_settings", { practiceId: ctx.practiceId })) {
      throw data(null, { status: 403 });
    }

    // 2. Parse the per-row decisions. Returned (422), never thrown.
    const entries: GoogleMappingEntry[] = [];
    const fieldErrors: FieldErrors = {};
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith("decision:") || typeof value !== "string") continue;
      const googleLocationName = key.slice("decision:".length);
      if (value === "") continue; // undecided — no entry, by design
      if (value === "skip") {
        entries.push({ googleLocationName, decision: { kind: "skip" } });
      } else if (value.startsWith("map:")) {
        entries.push({
          googleLocationName,
          decision: { kind: "map", locationId: value.slice("map:".length) },
        });
      } else if (value === "create") {
        const field = (name: string): string | null => {
          const raw = formData.get(`create:${googleLocationName}:${name}`);
          const trimmed = typeof raw === "string" ? raw.trim() : "";
          return trimmed === "" ? null : trimmed;
        };
        const name = field("name");
        if (!name) {
          fieldErrors[`decision:${googleLocationName}`] = [
            "Enter a name for the new location.",
          ];
          continue;
        }
        entries.push({
          googleLocationName,
          decision: {
            kind: "create",
            name,
            addressLine1: field("addressLine1"),
            city: field("city"),
            state: field("state"),
            postalCode: field("postalCode"),
          },
        });
      }
    }
    if (Object.keys(fieldErrors).length > 0) {
      return data({ fieldErrors }, { status: 422 });
    }

    // 3. Mutate + audit — one transaction inside the shared helper.
    const result = await saveGoogleLocationMappings(db, {
      practiceId: ctx.practiceId,
      actor: ctx.auditActor,
      entries,
    });
    if (result.status === "not_found") {
      throw data(null, { status: 404 });
    }
    if (result.status === "invalid") {
      return data(
        { fieldErrors: issuesToFieldErrors(result.issues) },
        { status: 422 },
      );
    }

    // 4 + 5. Flash, then redirect.
    return redirect(SELF, {
      headers: await setFlash(env, {
        tone: "positive",
        message: "Location mapping saved",
      }),
    });
  });
}

function RowSelect({
  row,
  locations,
  value,
  onChange,
  error,
}: {
  row: MappingRow;
  locations: Array<{ id: string; name: string }>;
  value: string;
  onChange: (value: string) => void;
  error: string | undefined;
}) {
  const hint = !row.verified
    ? undefined
    : row.suggested && value === row.initialValue
      ? "Suggested match."
      : undefined;
  return (
    <Select
      name={`decision:${row.googleLocationName}`}
      aria-label={`Import decision for ${row.title}`}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={!row.verified}
      {...(error !== undefined ? { error } : {})}
      {...(hint !== undefined ? { hint } : {})}
      options={[
        { value: "", label: "Choose…" },
        { value: "skip", label: "Don't import" },
        { value: "create", label: "Create new location" },
        ...locations.map((location) => ({
          value: `map:${location.id}`,
          label: location.name,
        })),
      ]}
    />
  );
}

function CreateFields({ row }: { row: MappingRow }) {
  const name = (field: string) => `create:${row.googleLocationName}:${field}`;
  const d = row.createDefaults;
  return (
    <div className="mt-3 flex flex-col gap-3 border border-hairline bg-surface-sunken p-3.5">
      <Input
        name={name("name")}
        label="New location name"
        defaultValue={d.name}
      />
      <Input
        name={name("addressLine1")}
        label="Address"
        defaultValue={d.addressLine1}
      />
      <div className="grid grid-cols-3 gap-3">
        <Input name={name("city")} label="City" defaultValue={d.city} />
        <Input name={name("state")} label="State" defaultValue={d.state} />
        <Input
          name={name("postalCode")}
          label="ZIP"
          defaultValue={d.postalCode}
        />
      </div>
    </div>
  );
}

export default function GoogleLocations({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const fieldErrors =
    actionData && "fieldErrors" in actionData
      ? actionData.fieldErrors
      : undefined;
  const refreshError =
    actionData && "refreshError" in actionData
      ? actionData.refreshError
      : undefined;

  // Controlled selects: the create panel and the duplicate-mapping note
  // both react to in-progress choices, before any save.
  const initialValues = useMemo(() => {
    if (!loaderData.connected) return {};
    return Object.fromEntries(
      loaderData.rows.map((row) => [row.googleLocationName, row.initialValue]),
    );
  }, [loaderData]);
  const [values, setValues] = useState<Record<string, string>>(initialValues);

  if (!loaderData.connected) {
    return (
      <>
        <PageHeader
          overline="Settings · integrations"
          title="Google locations"
          description="Choose which Google Business Profile listings feed this practice."
        />
        <Card title="Not connected" className="max-w-130">
          <p className="m-0 text-small text-gray-600">
            Connect Google Business Profile first —{" "}
            <Link to="/settings/integrations" className="underline">
              go to integrations
            </Link>
            .
          </p>
        </Card>
      </>
    );
  }

  const { rows, locations, multiAccount, needsReauth } = loaderData;
  const currentValue = (row: MappingRow) =>
    values[row.googleLocationName] ?? row.initialValue;

  // The relocated-listing edge case: two Google listings on one location is
  // allowed, but worth a calm heads-up.
  const duplicateLocationIds = (() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const value = currentValue(row);
      if (value.startsWith("map:")) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    return new Set(
      [...counts.entries()].filter(([, n]) => n > 1).map(([v]) => v),
    );
  })();

  return (
    <>
      <PageHeader
        overline="Settings · integrations"
        title="Google locations"
        description="Choose which Google Business Profile listings feed this practice. Unmapped listings aren't imported."
      />
      <div className="flex max-w-3xl flex-col gap-3.5">
        {needsReauth && (
          <Card sunken>
            <p className="m-0 text-small text-gray-600">
              Google stopped accepting our access — mapping still saves, but
              nothing imports until you{" "}
              <Link to="/settings/integrations" className="underline">
                reconnect
              </Link>
              .
            </p>
          </Card>
        )}

        <Form method="post">
          <input type="hidden" name="intent" value="refresh" />
          <div className="flex items-center gap-3">
            <Button type="submit" variant="secondary" size="sm" disabled={busy}>
              Refresh locations
            </Button>
            {refreshError && (
              <p className="m-0 text-small text-red-700" role="alert">
                {refreshError}
              </p>
            )}
          </div>
        </Form>

        {rows.length === 0 ? (
          <Card>
            <p className="m-0 text-small text-gray-600">
              No locations found on the connected Google account yet. Refresh
              after your Business Profile is set up, or reconnect with a
              different Google account.
            </p>
          </Card>
        ) : (
          <Form method="post">
            <input type="hidden" name="intent" value="save" />
            <div className="flex flex-col gap-3.5">
              {rows.map((row) => {
                const value = currentValue(row);
                const error =
                  fieldErrors?.[`decision:${row.googleLocationName}`]?.[0];
                return (
                  <Card key={row.googleLocationName}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="m-0 text-body font-semibold text-ink-900">
                            {row.title}
                          </h4>
                          {!row.verified && (
                            <Badge tone="caution">Unverified on Google</Badge>
                          )}
                        </div>
                        {row.address && (
                          <p className="m-0 mt-1 text-small text-gray-600">
                            {row.address}
                          </p>
                        )}
                        {multiAccount && (
                          <p className="m-0 mt-1 font-mono text-2xs uppercase tracking-label text-gray-500">
                            {row.accountDisplayName}
                          </p>
                        )}
                        {!row.verified && (
                          <p className="m-0 mt-2 text-small text-gray-500">
                            Google doesn't share reviews for unverified
                            listings, so this one can't be imported. Verify it
                            in Google Business Profile, then refresh.
                          </p>
                        )}
                      </div>
                      <div className="w-full sm:w-64 sm:shrink-0">
                        <RowSelect
                          row={row}
                          locations={locations}
                          value={value}
                          onChange={(next) =>
                            setValues((prev) => ({
                              ...prev,
                              [row.googleLocationName]: next,
                            }))
                          }
                          error={error}
                        />
                        {value.startsWith("map:") &&
                          duplicateLocationIds.has(value) && (
                            <p className="m-0 mt-1.5 text-small text-gray-500">
                              Two Google listings map to this location — fine
                              for a moved or duplicate listing.
                            </p>
                          )}
                      </div>
                    </div>
                    {row.verified && value === "create" && (
                      <CreateFields row={row} />
                    )}
                  </Card>
                );
              })}
            </div>
            <div className="mt-5 flex items-center gap-3">
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save mapping"}
              </Button>
              <Link
                to="/settings/integrations"
                className={buttonVariants({ variant: "ghost", size: "sm" })}
              >
                Back to integrations
              </Link>
            </div>
          </Form>
        )}
      </div>
    </>
  );
}
