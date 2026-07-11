/**
 * Webhook route unit tests (issue #60): everything that resolves BEFORE
 * any DB statement. The env's HYPERDRIVE points at an unreachable address,
 * so a test passing here proves "no DB writes" by construction — any query
 * would fail the request. Signatures are real svix signatures generated
 * with a known test secret; DB paths live in webhooks.integration.test.ts.
 */

import { resetEnvCache } from "@wellregarded/core";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/app";
import organizationCreated from "./fixtures/clerk/organization.created.json";
import { testEnv } from "./support/env";
import { deliver, signDelivery } from "./support/webhooks";

beforeEach(() => {
  resetEnvCache();
});

describe("POST /webhooks/clerk — signature verification", () => {
  it("rejects a missing signature with 400 and no body detail", async () => {
    const res = await app.request(
      "/webhooks/clerk",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(organizationCreated),
      },
      testEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("");
  });

  it("rejects a signature from the wrong secret", async () => {
    const res = await deliver(organizationCreated, testEnv(), {
      secret: `whsec_${Buffer.from("the-wrong-signing-secret!").toString("base64")}`,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("");
  });

  it("rejects a body tampered with after signing", async () => {
    const { headers } = signDelivery(organizationCreated);
    const tampered = JSON.stringify({
      ...organizationCreated,
      data: { ...organizationCreated.data, name: "Evil Dental" },
    });
    const res = await app.request(
      "/webhooks/clerk",
      { method: "POST", headers, body: tampered },
      testEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("500s when the signing secret is not configured", async () => {
    const res = await deliver(
      organizationCreated,
      testEnv({ CLERK_WEBHOOK_SIGNING_SECRET: undefined }),
    );
    expect(res.status).toBe(500);
  });
});

describe("POST /webhooks/clerk — event dispatch", () => {
  it("acks unhandled event types with 200 and performs no writes", async () => {
    const res = await deliver(
      { type: "session.created", data: { id: "sess_1" }, object: "event" },
      testEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  it("acks organization.deleted (deliberately unhandled) with 200", async () => {
    const res = await deliver(
      {
        type: "organization.deleted",
        data: { id: "org_gone", object: "organization", deleted: true },
        object: "event",
      },
      testEnv(),
    );
    expect(res.status).toBe(200);
  });

  it("400s a handled event type whose payload is malformed", async () => {
    const res = await deliver(
      { type: "organization.created", data: { id: "org_1" }, object: "event" },
      testEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("400s a signed body that is not a Clerk event envelope", async () => {
    const res = await deliver(["not", "an", "event"], testEnv());
    expect(res.status).toBe(400);
  });
});
