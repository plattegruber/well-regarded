/**
 * The two documented ways to run the fake (issue #130, requirements 6–7):
 *
 * 1. IN-PROCESS for Vitest — no port, no race: `app.fetch` routes on the
 *    path alone, so it can be injected as the `fetch` implementation while
 *    the code under test keeps using the REAL Google URLs. This is the
 *    pattern #118/#123/#127 build on (all Google-calling code accepts an
 *    injectable base URL/fetch).
 *
 * 2. STANDALONE over HTTP — what `pnpm dev:fake-gbp` does (via
 *    @hono/node-server on port 8799); here booted on an ephemeral port.
 */

import { serve } from "@hono/node-server";
import { describe, expect, it } from "vitest";

import { createFakeGbp } from "./app.js";
import { generateFixturePractice } from "./fixtures.js";
import type {
  GbpAccountsListResponse,
  GbpReviewsListResponse,
  OauthTokenResponse,
} from "./types.js";

describe("in-process usage (mounted fetch)", () => {
  it("answers the real Google hosts through an injected fetch", async () => {
    const { app, store } = createFakeGbp();
    generateFixturePractice(store, { seed: 42 });
    const code = store.issueAuthCode();

    // What a worker under test receives instead of global fetch:
    const injectedFetch: typeof fetch = async (input, init) =>
      app.fetch(new Request(input, init));

    // OAuth against the real token URL.
    const tokenRes = await injectedFetch(
      "https://oauth2.googleapis.com/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=authorization_code&code=${code}`,
      },
    );
    const { access_token } = (await tokenRes.json()) as OauthTokenResponse;
    expect(access_token).toBe("fake-access-token-1");

    // Account Management + v4 reviews against their real hosts.
    const headers = { Authorization: `Bearer ${access_token}` };
    const accounts = (await (
      await injectedFetch(
        "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
        { headers },
      )
    ).json()) as GbpAccountsListResponse;
    expect(accounts.accounts?.[0]?.accountName).toBe(
      "Cedar Ridge Dental Group",
    );

    const reviews = (await (
      await injectedFetch(
        "https://mybusiness.googleapis.com/v4/accounts/1/locations/1/reviews?pageSize=5",
        { headers },
      )
    ).json()) as GbpReviewsListResponse;
    expect(reviews.reviews).toHaveLength(5);
    expect(reviews.totalReviewCount).toBe(15);
  });
});

describe("standalone usage (@hono/node-server)", () => {
  it("boots and answers /v1/accounts over real HTTP", async () => {
    const { app, store } = createFakeGbp();
    store.addAccount({ accountName: "Standalone Smoke Test" });
    const token = store.issueAccessToken();

    const server = serve({ fetch: app.fetch, port: 0 });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error(`expected a TCP address, got: ${String(address)}`);
      }
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/accounts`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as GbpAccountsListResponse;
      expect(body.accounts?.[0]?.accountName).toBe("Standalone Smoke Test");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
