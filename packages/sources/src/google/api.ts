/**
 * Google Business Profile v1 data-API client for location discovery
 * (issue #121, Epic #7): `listAccounts` (Account Management v1),
 * `listLocations` (Business Information v1), and the
 * `discoverGoogleLocations` orchestration that flattens a connection's
 * accounts × locations into the snapshot persisted on
 * `source_connections.metadata.googleLocations`.
 *
 * Worker-runtime clean (fetch only), everything injectable: base URLs come
 * from env (`GOOGLE_ACCOUNT_MANAGEMENT_URL` /
 * `GOOGLE_BUSINESS_INFORMATION_URL` — local dev and tests point both at
 * the fake GBP server, #130) and `fetch` can be replaced in-process
 * (`fakeGbp.app.fetch`). The caller supplies a valid access token (from
 * `createGoogleAccessTokenProvider`, #118) — this module never refreshes.
 *
 * API facts baked in (ADR 0002 §2, #121 adjustments):
 * - `accounts.list` pages are max (and default) **20**;
 * - `locations.list` **requires `readMask`** and pages max 100;
 * - the v1 location carries no `verificationState` string — verified
 *   status is read from `metadata.hasVoiceOfMerchant`;
 * - pagination is sequential on purpose (Google's guidance: pace evenly,
 *   never fan out in parallel — the 300 QPM quota is per-project).
 *
 * Response schemas are `z.looseObject` (proto3 omits empty fields; Google
 * adds fields without notice — tolerate unknowns, same posture as
 * schema.ts).
 */

import type { GoogleDiscoveredLocation } from "@wellregarded/core";
import { z } from "zod";

/** `locations.list` readMask: identity, display fields, and the verified-status flag. */
export const GOOGLE_LOCATIONS_READ_MASK =
  "name,title,storefrontAddress,metadata";

/** `accounts.list` page size: 20 is both the default AND the max. */
const ACCOUNTS_PAGE_SIZE = 20;
/** `locations.list` page size: max 100 (default would be 10). */
const LOCATIONS_PAGE_SIZE = 100;

/** A non-2xx (or malformed) response from a GBP data API. */
export class GoogleApiError extends Error {
  readonly status: number;
  /** Google's error `status` string (e.g. `UNAUTHENTICATED`) when present. */
  readonly googleStatus: string | undefined;

  constructor(what: string, status: number, googleStatus?: string) {
    super(
      `Google Business Profile ${what} failed with status ${status}` +
        (googleStatus ? ` (${googleStatus})` : ""),
    );
    this.name = "GoogleApiError";
    this.status = status;
    this.googleStatus = googleStatus;
  }
}

export interface GoogleDataApiConfig {
  /** Base URL of Account Management v1 (real: `https://mybusinessaccountmanagement.googleapis.com`). */
  accountManagementUrl: string;
  /** Base URL of Business Information v1 (real: `https://mybusinessbusinessinformation.googleapis.com`). */
  businessInformationUrl: string;
  /** A valid access token. NEVER-LOG(credentials). */
  accessToken: string;
  /** Injectable for tests (`fakeGbp.app.fetch`-backed). Default: global fetch. */
  fetch?: typeof fetch;
}

const googleAccountSchema = z.looseObject({
  /** `accounts/{id}` — the resource name locations are listed under. */
  name: z.string().min(1),
  /** Human-readable account name (annotates multi-account UIs). */
  accountName: z.string().optional(),
});
export type GoogleAccount = z.infer<typeof googleAccountSchema>;

const accountsListResponseSchema = z.looseObject({
  accounts: z.array(googleAccountSchema).optional(),
  nextPageToken: z.string().optional(),
});

const postalAddressSchema = z.looseObject({
  postalCode: z.string().optional(),
  administrativeArea: z.string().optional(),
  locality: z.string().optional(),
  addressLines: z.array(z.string()).optional(),
});

const googleLocationSchema = z.looseObject({
  /** `locations/{id}` — NOT account-scoped; the stable identity key. */
  name: z.string().min(1),
  title: z.string().optional(),
  storefrontAddress: postalAddressSchema.optional(),
  metadata: z
    .looseObject({ hasVoiceOfMerchant: z.boolean().optional() })
    .optional(),
});
export type GoogleLocation = z.infer<typeof googleLocationSchema>;

const locationsListResponseSchema = z.looseObject({
  locations: z.array(googleLocationSchema).optional(),
  nextPageToken: z.string().optional(),
});

async function getJson<T extends z.ZodType>(
  config: GoogleDataApiConfig,
  what: string,
  url: URL,
  schema: T,
): Promise<z.infer<T>> {
  const doFetch = config.fetch ?? fetch;
  const response = await doFetch(url.toString(), {
    headers: { Authorization: `Bearer ${config.accessToken}` },
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const googleStatus =
      body &&
      typeof body === "object" &&
      "error" in body &&
      body.error &&
      typeof body.error === "object" &&
      "status" in body.error &&
      typeof body.error.status === "string"
        ? body.error.status
        : undefined;
    throw new GoogleApiError(what, response.status, googleStatus);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new GoogleApiError(what, response.status, "MALFORMED_RESPONSE");
  }
  return parsed.data;
}

/** All accounts the connected Google user can see, across pages of 20. */
export async function listAccounts(
  config: GoogleDataApiConfig,
): Promise<GoogleAccount[]> {
  const accounts: GoogleAccount[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL("/v1/accounts", config.accountManagementUrl);
    url.searchParams.set("pageSize", String(ACCOUNTS_PAGE_SIZE));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await getJson(
      config,
      "accounts.list",
      url,
      accountsListResponseSchema,
    );
    accounts.push(...(page.accounts ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return accounts;
}

/**
 * All locations under one account (`accounts/{id}`), across pages of 100,
 * with the discovery readMask applied.
 */
export async function listLocations(
  config: GoogleDataApiConfig,
  accountName: string,
): Promise<GoogleLocation[]> {
  const locations: GoogleLocation[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(
      `/v1/${accountName}/locations`,
      config.businessInformationUrl,
    );
    url.searchParams.set("readMask", GOOGLE_LOCATIONS_READ_MASK);
    url.searchParams.set("pageSize", String(LOCATIONS_PAGE_SIZE));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await getJson(
      config,
      "locations.list",
      url,
      locationsListResponseSchema,
    );
    locations.push(...(page.locations ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return locations;
}

/** Single formatted line from a PostalAddress; empty string when Google sent none. */
function formatAddress(
  address: z.infer<typeof postalAddressSchema> | undefined,
): string {
  if (!address) return "";
  const region = [address.administrativeArea, address.postalCode]
    .filter(Boolean)
    .join(" ");
  return [...(address.addressLines ?? []), address.locality, region]
    .filter((part) => part && part.length > 0)
    .join(", ");
}

/**
 * One discovery run: list every account, then every location under each —
 * sequentially, server-side (several round trips; never waterfall this
 * from a browser) — flattened into snapshot entries annotated with their
 * account. The caller persists the result wholesale as
 * `metadata.googleLocations`.
 */
export async function discoverGoogleLocations(
  config: GoogleDataApiConfig,
  now: () => Date = () => new Date(),
): Promise<GoogleDiscoveredLocation[]> {
  const discovered: GoogleDiscoveredLocation[] = [];
  const accounts = await listAccounts(config);
  for (const account of accounts) {
    const locations = await listLocations(config, account.name);
    const discoveredAt = now().toISOString();
    for (const location of locations) {
      discovered.push({
        googleLocationName: location.name,
        googleAccountName: account.name,
        accountDisplayName: account.accountName ?? account.name,
        title: location.title ?? "",
        address: formatAddress(location.storefrontAddress),
        verificationState:
          location.metadata?.hasVoiceOfMerchant === true
            ? "verified"
            : "unverified",
        discoveredAt,
      });
    }
  }
  return discovered;
}
