/**
 * Standalone mode for the fake GBP server (issue #130, requirement 6).
 *
 *     pnpm dev:fake-gbp            # from the repo root
 *     FAKE_GBP_PORT=9000 pnpm dev:fake-gbp
 *
 * Serves on http://localhost:8799 by default (8787-adjacent, clear of the
 * wrangler dev ports) via @hono/node-server, pre-seeded with the seed-42
 * Cedar Ridge fixture practice, and prints ready-to-use credentials.
 * Local workers point their Google base URLs at it via `.dev.vars`
 * (see the `.dev.vars.example` files under `workers/`).
 */

import { serve } from "@hono/node-server";

import {
  createFakeGbp,
  FAKE_GBP_DEFAULT_PORT,
  GOOGLE_FIXTURE_SEED,
  generateFixturePractice,
} from "../src/google/fake/index.js";

const port = Number(process.env.FAKE_GBP_PORT ?? FAKE_GBP_DEFAULT_PORT);

const { app, store } = createFakeGbp();
const { account, locations, reviews } = generateFixturePractice(store, {
  seed: GOOGLE_FIXTURE_SEED,
});
const authCode = store.issueAuthCode();
const accessToken = store.issueAccessToken();

serve({ fetch: app.fetch, port }, (info) => {
  const base = `http://localhost:${info.port}`;
  console.log(`fake GBP server listening on ${base}
`);
  console.log(`Seeded (seed ${GOOGLE_FIXTURE_SEED}): ${account.accountName} — ${locations.length} locations, ${reviews.length} reviews.
`);
  console.log(`Point Google base URLs here (all five real hosts are served from this one origin):
  OAuth token .......... POST ${base}/oauth/token
  Account Management ... GET  ${base}/v1/accounts
  Business Info ........ GET  ${base}/v1/accounts/1/locations?readMask=*
  Verifications ........ GET  ${base}/v1/locations/1/VoiceOfMerchantState
  Reviews (v4) ......... GET  ${base}/v4/accounts/1/locations/1/reviews
  Reply (v4) ........... PUT  ${base}/v4/accounts/1/locations/1/reviews/1/reply
  Media (v4) ........... GET  ${base}/v4/accounts/1/locations/1/media
`);
  console.log(`Credentials:
  auth code (single-use, exchange at /oauth/token) ... ${authCode}
  access token (ready to use as a Bearer) ............ ${accessToken}

  curl -H 'Authorization: Bearer ${accessToken}' '${base}/v1/accounts'
`);
});
