# GBP review polling (`SyncLock` + the 6h cron)

The incremental Google Business Profile review poller in `workers/jobs`
([#123](https://github.com/plattegruber/well-regarded/issues/123), Epic #7):
a 6-hourly cron enumerates every `active` google `source_connections` row
and hands each one to its per-connection **`SyncLock` Durable Object**,
which fetches new/edited reviews per mapped location, stores each raw page
in R2 (#100 store-before-enqueue), and enqueues one `IngestMessage` per
page onto `wr-ingest`. Design background: ADR 0002 (§3 quotas, Appendix A
math).

## The moving parts

| piece | file | job |
|---|---|---|
| cron tick | `workers/jobs/src/scheduled.ts` | enumerate active connections, stagger, invoke DOs |
| lock + runner | `workers/jobs/src/sync-lock.ts` | serialize syncs per connection; steal stale locks |
| sync engine | `workers/jobs/src/gbpSync.ts` | cursors, pacing, backoff, artifacts, import runs |
| pacing math | `workers/jobs/src/gbpPolling.ts` | every constant, with the quota reasoning |
| store | `workers/jobs/src/gbpSyncStore.ts` | drizzle-backed persistence + `needs_reauth` hook |
| reviews client | `packages/sources/src/google/client.ts` | v4 `reviews.list`, injectable base URL/fetch |
| location source | `packages/sources/src/google/mappings.ts` | `getActiveMappings` (#121): mapped + verified locations only |
| manual entry | `workers/api` `POST /api/integrations/google/sync` | same DO entry point, trigger `manual` |

## Quota & pacing (the part that is a correctness requirement)

Google's default 300 QPM quota is **per GCP project, shared across every
connected practice** — so the poller shapes traffic globally:

- **Stagger:** each connection's sync start is delayed by a deterministic
  hash of its id, spread over a 5-minute window. Deterministic on purpose:
  Google denies quota increases for spiky traffic; a stable, smooth shape
  is what earns headroom later.
- **Sequential + paced:** locations sync sequentially inside a connection,
  with ≥250 ms between Google calls (240 QPM = 80% of quota — Google's own
  "pace evenly" guidance, with headroom left for the api worker's calls).
- **Backoff:** per request, 3 attempts at 1 s/4 s/16 s with equal jitter,
  honoring `Retry-After`. On exhaustion the *remainder* of the sync aborts
  gracefully (run → `completed_with_errors`, quota error recorded); cursors
  already advanced stay advanced and the next tick resumes. Never a
  busy-loop against a quota error.

Scale check (ADR Appendix A): 100 practices ≈ 200 locations ≈ 200 calls per
tick ≈ 50 s paced — the 6h cadence has orders of magnitude of headroom.

## Cursors (incremental fetch)

Reviews are listed `orderBy=updateTime desc` (pageSize 50, the v4 max)
under the mapping's v4 account-scoped parent, walked newest-first until a
page dips into already-seen territory. The cursor is the max `updateTime`
seen per location, stored at
`source_connections.metadata.syncCursors[<locations/{id}>]` — keyed by the
mapping's STABLE v1 identity (#121's key; a listing moving between
accounts changes its v4 name, never its identity), in connection metadata
because that is where the mapping lives, and written via
`patchSourceConnectionMetadata` (per-top-level-key patch) so the #121
writers (mapping UI, discovery refresh) are never clobbered.

Crash-safety: the cursor advances **only after** the location's pages are
durable in R2 *and* enqueued. Re-polling an un-advanced cursor re-sends
artifacts the pipeline dedupes (#106) — and because `updateTime` (not
`createTime`) drives the cursor, edited reviews re-enter the pipeline
deliberately, becoming signal *versions* via dedupe's exact path.

Runaway guard: max 20 pages per location per sync (≈1,000 reviews); hitting
it logs loudly and the remainder arrives next tick.

## Lock semantics

One `SyncLock` DO per connection (`idFromName(connection.id)`); the DO runs
the sync itself, so the platform's per-instance serialization is the
overlap prevention. State is one storage record `{ token, startedAt }`:

- `acquire` — rejected while held (`already_running` with hold duration).
- **Steal after 30 min** (`SYNC_LOCK_STALE_MS`): a holder past the cap is
  presumed crashed; the thief takes over with a fresh token and logs
  `gbp.sync.lock_stolen` at error level — that log line is an incident.
- `release(token)` — token-fenced, so a stolen-from zombie finishing late
  cannot clobber the thief's lock.

Everything durable (cursors, run stats, connection status) lives in
Postgres; DO eviction costs nothing.

## Failure surfacing

- **429/5xx** → backoff, then graceful abort (above).
- **`invalid_grant`** → the token provider's `onInvalidGrant` hook flips
  the connection to `needs_reauth` + writes a system-actor audit row
  (`jobs:gbp-sync`) in one transaction, *before* the error propagates; the
  run finalizes `failed`. The settings card (#118) and the Today screen
  (Epic #11) both read `source_connections.status`.
- Every sync gets one `import_runs` row (trigger `cron`/`manual`), closed
  with `finalizeImportRunWithStatus` — the poller decides the terminal
  status itself because pipeline counts land asynchronously after the poll.
  Sync stats (`locations_polled`, `pages_stored`, `reviews_seen`,
  `cursors_advanced`, `quota_aborted`, …) accumulate in the run's `stats`,
  and every stored artifact key is recorded on the run BEFORE its message
  is enqueued — dedupe's `conflict_reimport` path re-reads the run's keys
  to version edited reviews (#106/#111 contract).

## Logs (the runbook's raw material)

One requestId per cron tick, stamped on every ingest message it produces.
Grep for: `gbp.poll.tick`, `gbp.poll.scheduled`, `gbp.sync.page_stored`
(carries Google's `totalReviewCount`/`averageRating` as a drift check),
`gbp.sync.cursor_advanced`, `gbp.sync.request_retry`,
`gbp.sync.quota_aborted`, `gbp.sync.needs_reauth`, `gbp.sync.lock_stolen`,
`gbp.sync.finished` (the per-sync summary).

## Running locally

```sh
pnpm dev:fake-gbp                  # fake Google on :8799 (seeded practice)
pnpm --filter @wellregarded/jobs dev -- --test-scheduled
curl "http://localhost:8789/cdn-cgi/handler/scheduled?cron=0+*%2F6+*+*+*"
```

`workers/jobs/.dev.vars` points the token URL and
`GOOGLE_MYBUSINESS_V4_BASE_URL` at the fake. For the tick to find work you
need an `active` google connection row whose encrypted refresh token the
fake honors and whose metadata carries the #121 state (a
`googleLocations` snapshot plus `locationMappings` entries with
`locationId`s — only mapped + verified locations poll). The integration
suite (`pnpm --filter @wellregarded/jobs test:integration`) builds exactly
this state and is the fastest way to see the whole flow. Note
`wrangler dev --test-scheduled` exercises the real `scheduled` handler and
DOs, but not the production cron scheduler itself — the expression is
config, verified by eye + the `GBP_POLL_CRON` dispatch check.
