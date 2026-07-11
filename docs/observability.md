# Observability

Seed of the observability runbook (issue #64, Epic #24). This page covers
the logging plumbing: the structured-logging convention, how request ids
flow through the system, and how to actually see the logs on Cloudflare.
Error tracking (Sentry, #66), the pipeline health view, and alerting are
separate Epic #24 issues and land on top of this.

## The one logging convention

Every worker and app logs **single-line JSON via the redacting logger** in
[`packages/core/src/log/`](../packages/core/src/log/README.md) — that README
is the contract (emitted shape, levels, redaction rules, the Biome
`noConsole` enforcement). Never `console.log` directly in `apps/*` or
`workers/*`; lint fails the build if you do.

```ts
import { createLogger, logLevelFor } from "@wellregarded/core";

const log = createLogger({
  worker: "pipeline",
  requestId: message.requestId,
  practiceId: message.practiceId,
  stage: "dedupe",
  level: logLevelFor(env.ENVIRONMENT), // debug only in local
});
log.info("signal deduped", { signalId, importRunId });
```

## Request-id propagation map

One `requestId` follows a signal across every execution context. Grepping it
in Workers Logs shows the full journey — API edge → normalize → dedupe →
classify → route — end to end.

| Hop | Where the id comes from |
| --- | --- |
| `workers/api` HTTP edge | `requestId()` Hono middleware (first in the chain): honors inbound `x-request-id`, then `cf-ray`, else mints `crypto.randomUUID()`; echoes `x-request-id` on the response. |
| `apps/dashboard` edge | Same resolution in the worker fetch handler (`workers/app.ts`); loaders/actions get `context.requestId` / `context.logger`. |
| Cron/poll ingestion (`workers/jobs`) | No inbound request exists — the adapter entry mints a fresh UUID and stamps it on the ingest message. |
| Queue messages | The pipeline envelope (`packages/core/src/pipeline/messages.ts`) carries `requestId`; **every producer copies it forward**. It is optional on the wire (old in-flight messages), and `parsePipelineMessage` backfills `unknown-<uuid>` so consumers never crash on legacy messages. |
| DLQ forwards | The dispatcher's `DlqForwardEnvelope` carries the failed message's `requestId` (best-effort for malformed bodies). |
| Workflows | **Convention (no Workflows exist yet):** every Workflow's params object MUST include `requestId`, and each step creates its logger (or a `.child({ stage: "<step>" })`) from it. Enforce this in review until the first Workflow lands with a helper. |

## Workers Logs

[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
is enabled for every worker in its `wrangler.jsonc`:

```jsonc
"observability": {
  "enabled": true,
  "head_sampling_rate": 1 // keep every log at launch volumes
}
```

`observability` is an inheritable wrangler key, so the top-level block covers
`env.preview` and `env.prod` too (unlike bindings, which must be repeated).
Workers Logs ingests everything written to `console.*`, parses JSON lines,
and indexes their fields — which is exactly why the logger emits one JSON
object per line. Retention is 3 days (Free) / 7 days (Paid); the sampling
rate stays at `1` until volume forces a decision, and any change belongs in
this file next to the reasoning.

### Querying by requestId

Cloudflare dashboard → **Workers & Pages → your worker → Logs**:

- Filter by field: `requestId equals <id>` (fields from JSON log lines are
  auto-indexed). Do this per worker; a signal's journey spans `wr-api-*` and
  `wr-pipeline-*` at minimum.
- Or use **Observability → Investigate** and query
  `requestId = "<id>"` across workers on one screen.
- Live tail during an incident: `pnpm wrangler tail wr-pipeline-prod
  --format json | grep <requestId>` (add `--env prod` variants per worker
  naming in `infra/environments.md`).

Useful secondary filters: `practiceId` (tenant), `stage` (pipeline stage or
route), `level equals error`, `msg equals pipeline.dispatch.retry`.

## Logpush (later, deliberately)

[Workers Logpush](https://developers.cloudflare.com/workers/observability/logs/logpush/)
would stream the same logs to external storage (R2, S3, an analytics stack)
for **longer retention than 3–7 days, cross-worker querying in one store,
and joining with request analytics**. It requires the Workers Paid plan and
a destination we would have to operate, and at launch volumes Workers Logs
answers every question we have — so it stays OFF. Turn it on when either
(a) an incident post-mortem needs logs older than the retention window, or
(b) compliance requires log archival; wire it to R2 first (cheapest, no new
vendor). Track the decision here.

## Log hygiene rules

- Never log signal text, message bodies, or contact details — log
  `signalId` / lengths. The logger's redaction
  (`/phone|email|name|text|token|body|content/i` → `"[redacted]"`, deep) is
  a seatbelt, not permission; `allowUnsafe` uses require a justifying code
  comment.
- `msg` is a stable string (`"pipeline.dispatch.retry"`, `"signal
  ingested"`); variability goes in fields so lines stay countable.
- `debug` never ships to preview/prod (`logLevelFor` compiles it out); if
  you need it in an incident, that is what `wrangler tail` on a canary is
  for.
