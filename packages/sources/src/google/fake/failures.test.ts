import { describe, expect, it } from "vitest";

import { createFakeGbp } from "./app.js";

function setup() {
  const { app, store } = createFakeGbp();
  store.addAccount();
  const token = store.issueAccessToken();
  const getAccounts = () =>
    app.request("/v1/accounts", {
      headers: { Authorization: `Bearer ${token}` },
    });
  return { app, store, token, getAccounts };
}

describe("store.failNext", () => {
  it("fires exactly `times` and then clears", async () => {
    const { store, getAccounts } = setup();
    store.failNext("GET /v1/accounts", { status: 500, times: 2 });

    expect((await getAccounts()).status).toBe(500);
    expect((await getAccounts()).status).toBe(500);
    expect((await getAccounts()).status).toBe(200);
    expect((await getAccounts()).status).toBe(200);
  });

  it("defaults to one Google-shaped failure", async () => {
    const { store, getAccounts } = setup();
    store.failNext("/v1/accounts", { status: 500 });

    const res = await getAccounts();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      error: { code: 500, status: "INTERNAL" },
    });
    expect((await getAccounts()).status).toBe(200);
  });

  it("429s carry Retry-After and a RESOURCE_EXHAUSTED body — the #123 backoff diet", async () => {
    const { store, getAccounts } = setup();
    store.failNext("GET /v1/accounts", { status: 429 });

    const res = await getAccounts();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(await res.json()).toMatchObject({
      error: { code: 429, status: "RESOURCE_EXHAUSTED" },
    });
  });

  it("honors custom headers and bodies (e.g. a longer Retry-After)", async () => {
    const { store, getAccounts } = setup();
    store.failNext("GET /v1/accounts", {
      status: 429,
      headers: { "Retry-After": "30" },
      body: {
        error: { code: 429, message: "Custom.", status: "RESOURCE_EXHAUSTED" },
      },
    });

    const res = await getAccounts();
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(await res.json()).toMatchObject({ error: { message: "Custom." } });
  });

  it("scripts invalid_grant on the token endpoint without bespoke flags (#118)", async () => {
    const { app, store } = setup();
    store.failNext("POST /oauth/token", {
      status: 400,
      body: {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      },
    });

    const res = await app.request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=whatever",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("supports transient-then-success sequences (#127's retry matrix)", async () => {
    const { store, getAccounts } = setup();
    store.failNext("GET /v1/accounts", { status: 503 });
    expect((await getAccounts()).status).toBe(503);
    expect((await getAccounts()).status).toBe(200);
  });

  it("matches by regex and by predicate", async () => {
    const { store, getAccounts } = setup();
    store.failNext(/GET \/v1\/acc/, { status: 500 });
    expect((await getAccounts()).status).toBe(500);

    store.failNext(
      (method, path) => method === "GET" && path.endsWith("/accounts"),
      {
        status: 503,
      },
    );
    expect((await getAccounts()).status).toBe(503);
    expect((await getAccounts()).status).toBe(200);
  });

  it("string matching is a case-insensitive substring of 'METHOD /path'", async () => {
    const { store, getAccounts } = setup();
    store.failNext("get /v1/ACCOUNTS", { status: 500 });
    expect((await getAccounts()).status).toBe(500);
  });

  it("only affects matching endpoints", async () => {
    const { store, getAccounts } = setup();
    store.failNext("GET /v4/", { status: 429 });
    expect((await getAccounts()).status).toBe(200);
  });

  it("delayMs without a status delays the request, then serves it normally", async () => {
    const { store, getAccounts } = setup();
    store.failNext("GET /v1/accounts", { delayMs: 120 });

    const started = Date.now();
    const res = await getAccounts();
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it("delayMs with a status delays the failure (slow 500s exist in the wild)", async () => {
    const { store, getAccounts } = setup();
    store.failNext("GET /v1/accounts", { status: 500, delayMs: 120 });

    const started = Date.now();
    const res = await getAccounts();
    expect(res.status).toBe(500);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it("failure injection preempts auth (an unauthenticated request can still draw the scripted failure)", async () => {
    const { app, store } = setup();
    store.failNext("GET /v1/accounts", { status: 429 });
    const res = await app.request("/v1/accounts"); // no bearer at all
    expect(res.status).toBe(429);
  });

  it("reset() clears pending failure scripts (and tokens)", async () => {
    const { app, store } = setup();
    store.failNext("GET /v1/accounts", { status: 500, times: 5 });
    store.reset();
    store.addAccount();
    const fresh = store.issueAccessToken();
    const res = await app.request("/v1/accounts", {
      headers: { Authorization: `Bearer ${fresh}` },
    });
    expect(res.status).toBe(200);
  });
});
