# `@wellregarded/core` — structured logging (`src/log/`)

The one logging convention for the whole repo (issue #64, Epic #24): every
worker and app emits **single-line JSON to `console.log`** through the
redacting logger in this module. Cloudflare [Workers
Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
indexes the fields of JSON console lines, so one `requestId` greps a signal's
whole journey — API edge → normalize → dedupe → classify → route — end to
end. See [`docs/observability.md`](../../../../docs/observability.md) for the
platform side (enabling Workers Logs, querying, Logpush).

## Emitted shape

```json
{"level":"info","ts":"2026-07-11T12:00:00.000Z","msg":"signal ingested","worker":"api","requestId":"5e0f…","practiceId":"9c2a…","stage":"/webhooks/clerk","signalId":"…"}
```

- `level` — `debug | info | warn | error`. Default minimum level is `info`;
  `debug` is emitted only when the logger was created with
  `level: logLevelFor(env.ENVIRONMENT)` **and** the environment is `local`
  (debug is compiled out in preview/prod).
- `msg` — a stable, human-written string. Put variability in fields, not in
  `msg`, so lines stay groupable.
- `requestId` — minted at the edge, propagated everywhere (see below).
- `worker` — `api`, `pipeline`, `jobs`, `dashboard`, `patient`, `ai`.
- `stage` — pipeline stage or route name, when known.
- `ts` — ISO-8601 timestamp.
- …plus arbitrary extra fields, after redaction.

## API

```ts
import { createLogger, logLevelFor } from "@wellregarded/core";

const log = createLogger({
  worker: "api",
  requestId,             // from the edge middleware / queue message
  practiceId,            // optional
  level: logLevelFor(env.ENVIRONMENT), // optional; default "info"
});

log.info("signal ingested", { signalId, sourceKind });
log.error("normalize failed", { error }); // Error values serialize as {kind,message,stack}

const stageLog = log.child({ stage: "dedupe" }); // bind more context
```

## Request-id propagation

- **HTTP edge** — `workers/api` mints the id in its `requestId()` Hono
  middleware (first in the chain) via `resolveRequestId(x-request-id, cf-ray)`;
  the dashboard worker does the same before calling the React Router request
  handler. The id is echoed back in the `x-request-id` response header.
- **Queues** — the pipeline message envelope
  (`packages/core/src/pipeline/messages.ts`) carries an optional `requestId`.
  Every producer copies it forward; `parsePipelineMessage` guarantees
  consumers a value by falling back to `unknown-<uuid>` for legacy messages.
- **Cron/poll ingestion** — no inbound request exists, so the adapter entry
  mints a fresh `crypto.randomUUID()` and stamps it on the ingest message.
- **Workflows** — none exist yet; the convention is that every Workflow's
  params include `requestId`, and each step creates a child logger from it.

## PII never reaches logs — two enforcement mechanisms

### 1. Runtime redaction (default-on)

Any field whose **key** matches

```ts
/phone|email|name|text|token|body|content/i
```

is replaced with `"[redacted]"` — at **every** nesting depth, so
`{ patient: { phone: "555-0100" } }` logs as
`{ "patient": { "phone": "[redacted]" } }`. A key that matches with an
object/array value redacts the whole subtree. Serialization also caps depth
at 8 levels (`"[max-depth]"`) and guards circular references
(`"[circular]"`), so logging can never throw.

The escape hatch is an explicit allowlist, and **every use must carry a code
comment** explaining why the field is safe:

```ts
const log = createLogger({
  worker: "api",
  requestId,
  // `hostname` is our own deploy metadata, not user data.
  allowUnsafe: ["hostname"],
});
```

The redactor is a seatbelt, not permission: do not log message bodies or
signal text anywhere, even expecting redaction — log `signalId` and lengths
instead.

### 2. Lint-time: Biome `noConsole`

The `overrides` block in [`/biome.json`](../../../../biome.json) turns on
`suspicious/noConsole` as an **error** for all source under `apps/**` and
`workers/**` (test files excluded — they spy on console to capture logger
output). A raw `console.log`/`console.error` in a worker fails `pnpm lint`
and CI; the only sanctioned transport is this module, which lives in
`packages/core`, outside the override's scope.
