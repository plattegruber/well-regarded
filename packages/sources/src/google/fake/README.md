# Fake Google Business Profile server

The local stand-in for Google's Business Profile APIs (issue #130, Epic #7).
Real GBP access is human-gated (Google approval, 0 QPM until then, no
sandbox — ADR 0002) and **no test may call a real external API**, so every
Epic #7 issue (#118 OAuth, #121 locations, #123 polling, #125 adapter,
#127 replies, #156 snapshots) develops and tests against this fake.

Import as `@wellregarded/sources/google/fake`. It ships in the repo but
**never deploys** — it is not exported from the package root, and nothing in
`infra/` or any wrangler config references it.

## The prime rule: fidelity bugs get fixed here first

Field names, enum values, pagination mechanics, and error envelopes are the
fidelity bar. **Any shape discovered wrong against real GBP gets fixed in
this fake first**, so every test in the repo inherits the correction — never
patch an adapter/worker around a fake inaccuracy. (Then regenerate the
recorded fixtures: `pnpm --filter @wellregarded/sources gen:google-fixtures`.)

## Surface

Real Google spreads these across five hosts; the fake serves all of them
from one origin (base URLs are injectable everywhere, per #118/#123/#127):

| Fake path | Real endpoint (ADR 0002 §2) |
|---|---|
| `POST /oauth/token` | `oauth2.googleapis.com/token` |
| `GET /v1/accounts` | Account Management v1 (`pageSize` default **and max 20**) |
| `GET /v1/accounts/{a}/locations` | Business Information v1 (**`readMask` required**, max 100) |
| `GET /v1/locations/{l}` | Business Information v1 (profile fields for #156) |
| `GET /v1/locations/{l}/VoiceOfMerchantState` | Verifications v1 (verified status) |
| `GET /v4/accounts/{a}/locations/{l}/reviews` | My Business v4 (`pageSize` max 50; `orderBy`: `updateTime desc` default, `rating`, `rating desc`) |
| `PUT/DELETE /v4/.../reviews/{r}/reply` | My Business v4 (upsert; 4096-**byte** cap; verified locations only) |
| `GET /v4/accounts/{a}/locations/{l}/media` | My Business v4 (`totalMediaItemCount` for #156) |

## Faithful (verified against ADR 0002)

- v4 `Review` shape: full-path `name` (`accounts/{a}/locations/{l}/reviews/{r}`
  — the adapter's `sourceId`), `starRating` enum, `reviewer` with
  `isAnonymous`, optional `comment` (absent on star-only reviews),
  `createTime`/`updateTime`, `reviewReply` with the 2026 moderation fields
  `reviewReplyState` (`PENDING`/`REJECTED`/`APPROVED`) and `policyViolation`.
- Proto3 JSON omission: empty lists/zero counts are **omitted**, not
  `null`/`0` (an empty reviews page is `{}`).
- List responses: `reviews` + `averageRating` + `totalReviewCount` +
  `nextPageToken`; locations carry `totalSize`.
- v1 location `name` is `locations/{l}` — **not** account-scoped; the v4
  reviews path is. #121 must join the two; the fake preserves the asymmetry.
- No `verificationState` string on locations: verified status is
  `metadata.hasVoiceOfMerchant` or the Verifications `VoiceOfMerchantState`.
- Missing `readMask` → 400 `INVALID_ARGUMENT`; invalid page tokens → 400;
  unknown entities → 404; missing/expired bearer → 401 `UNAUTHENTICATED`
  (Google error envelope `{ error: { code, message, status } }`).
- OAuth: form-encoded grants, single-use codes, `refresh_token` only on the
  code exchange, `invalid_grant` on bad/revoked grants, scope
  `https://www.googleapis.com/auth/business.manage`.

## Simplified / assumed (safe for our tests, verify before relying on more)

- **Auth is shallow**: any bearer the fake issued and hasn't expired is
  accepted — no scope or account-ownership checks. Enough to catch
  missing/stale-token bugs, nothing more.
- **Page tokens are offsets** (base64url), not real snapshot cursors; store
  mutations mid-walk can shift page boundaries (real Google has analogous
  races — consumers dedupe by review `name`).
- **`readMask` filtering is top-level**: `profile.description` selects all
  of `profile`; unknown fields 400 (real API may accept fields we don't
  model — extend `LOCATION_MASKABLE_FIELDS` when needed).
- **Assumption**: a reply upsert/delete/moderation change bumps the parent
  review's `updateTime` (this is how #123's poller re-sees moderation
  outcomes). Verify against real GBP when access lands.
- **Assumption**: the reply PUT response includes `reviewReplyState`
  (default `PENDING`; configurable via `new FakeGbpStore({ initialReplyState })`).
  Moderation outcomes are flipped by tests via `store.setReplyState(name,
  "REJECTED", policyViolation)`.
- Unverified-location replies return 400 `FAILED_PRECONDITION` — Google
  documents the restriction but not the exact code; adjust here if reality
  differs.
- Deterministic ids/tokens (`accounts/1`, `fake-access-token-1`) instead of
  Google's opaque blobs; `pageSize` over the max is clamped (Google may 400).
- Quotas are not simulated — script 429s explicitly with `failNext`.
- OAuth ignores `client_id`/`client_secret`/PKCE params, and the token
  endpoint also accepts JSON bodies (real Google: form-encoded only).

## In-process mode (Vitest — no port, no race)

`app.fetch` routes on the path only, so inject it as `fetch` and keep the
real Google URLs in the code under test:

```ts
import { createFakeGbp, generateFixturePractice } from "@wellregarded/sources/google/fake";

const { app, store } = createFakeGbp();
generateFixturePractice(store, { seed: 42 });
const token = store.issueAccessToken();

const injectedFetch: typeof fetch = async (input, init) =>
  app.fetch(new Request(input, init));
// pass injectedFetch (and/or a base URL) to the code under test
```

Drive scenarios through the store, not HTTP:

```ts
store.addReview({ starRating: "TWO", comment: "Long wait." });
store.editReview(name, { comment: "Resolved!" });      // bumps updateTime → resorts
store.setReplyState(name, "REJECTED", "policy reason"); // async moderation outcome
store.failNext("GET /v4/", { status: 429, times: 2 });  // then succeeds
store.expireAccessTokens();                              // 401 until refresh
store.reset();
```

## Standalone mode (local dev)

```sh
pnpm dev:fake-gbp        # http://localhost:8799 (FAKE_GBP_PORT to override)
```

Serves via `@hono/node-server`, pre-seeded with the seed-42 fixture
practice, and prints a ready auth code + access token. Local workers point
their Google base URLs at it through `.dev.vars` (see the commented
`GOOGLE_*_BASE_URL` block in `workers/*/.dev.vars.example`).

## Fixtures

`generateFixturePractice(store, { locations, reviewsPerLocation, seed })`
seeds a deterministic dental practice; the first six reviews per location
pin the quirk matrix (star-only, edited, replied APPROVED/REJECTED/PENDING,
anonymized). The recorded-shape files in `../fixtures/*.json` (used by the
adapter, #125) are generated **from this same code by driving the fake over
HTTP**, so server and fixtures cannot drift — `fixtures.test.ts` fails if
they do; regenerate with:

```sh
pnpm --filter @wellregarded/sources gen:google-fixtures
```
