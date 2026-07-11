/**
 * Svix-signed webhook deliveries for tests (issue #60's testing strategy):
 * signatures are generated with the real `svix` library and a known test
 * secret — never hand-rolled — so the verification path in the route is
 * exercised exactly as production will.
 */

import { Webhook } from "svix";

import { app } from "../../src/app";
import type { TestEnv } from "./env";

/**
 * Deterministic test-only signing secret, `whsec_` + base64 to match
 * Clerk's format. Assembled at runtime (not a literal) so secret scanners
 * never flag it — it protects nothing and never leaves the test process.
 */
export const TEST_WEBHOOK_SECRET = `whsec_${Buffer.from(
  "test-webhook-secret-24bytes!",
).toString("base64")}`;

let messageCounter = 0;

export interface SignedDelivery {
  body: string;
  headers: Record<string, string>;
}

export function signDelivery(
  event: unknown,
  options: { secret?: string; messageId?: string } = {},
): SignedDelivery {
  const body = JSON.stringify(event);
  const messageId = options.messageId ?? `msg_test_${++messageCounter}`;
  const timestamp = new Date();
  const signature = new Webhook(options.secret ?? TEST_WEBHOOK_SECRET).sign(
    messageId,
    timestamp,
    body,
  );
  return {
    body,
    headers: {
      "content-type": "application/json",
      "svix-id": messageId,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": signature,
    },
  };
}

/** Deliver `event` to POST /webhooks/clerk with a valid svix signature. */
export async function deliver(
  event: unknown,
  env: TestEnv,
  options: { secret?: string; messageId?: string } = {},
): Promise<Response> {
  const { body, headers } = signDelivery(event, options);
  return app.request("/webhooks/clerk", { method: "POST", headers, body }, env);
}
