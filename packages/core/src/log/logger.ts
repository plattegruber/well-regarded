/**
 * Structured logger for every worker and app (issue #64, Epic #24).
 *
 * One convention for the whole repo: single-line JSON to `console.log`, a
 * `requestId` minted at the edge and propagated through every hop (Hono
 * middleware → queue message envelope → Workflow params), and redaction by
 * default so the logger structurally cannot leak PII.
 *
 * Emitted shape (one JSON object per line):
 *
 *   { "level": "info", "ts": "…", "msg": "…", "worker": "api",
 *     "requestId": "…", "practiceId"?: "…", "stage"?: "…", ...fields }
 *
 * Usage:
 *
 *   const log = createLogger({ worker: "api", requestId, practiceId });
 *   log.info("signal ingested", { signalId, sourceKind });
 *   const stageLog = log.child({ stage: "dedupe" });
 *
 * Zero dependencies on purpose — pino/winston bring Node-isms Workers don't
 * want, and a redacting JSON-lines logger is small enough to own.
 *
 * PII enforcement (both mechanisms are documented in ./README.md):
 * 1. Runtime: any field whose key matches {@link PII_KEY_PATTERN} is
 *    replaced with `"[redacted]"` — at every nesting depth — unless the key
 *    is explicitly allowlisted via `allowUnsafe`. Every `allowUnsafe` use
 *    must carry a code comment justifying it.
 * 2. Lint-time: Biome's `noConsole` rule errors on raw `console.*` calls in
 *    `apps/*` and `workers/*` (see the `overrides` block in /biome.json), so
 *    all logging flows through this module.
 *
 * The redactor is a seatbelt, not permission: never log message bodies or
 * signal text anywhere, even expecting redaction — log `signalId` and
 * lengths instead.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Arbitrary extra fields attached to a log line or bound to a logger. */
export type LogFields = Record<string, unknown>;

/**
 * Field keys that are redacted by default, at any nesting depth. Broad on
 * purpose: false positives (e.g. `filename`) cost a `[redacted]` in a log
 * line; false negatives cost a PII leak.
 */
export const PII_KEY_PATTERN = /phone|email|name|text|token|body|content/i;

/** The value redacted fields are replaced with. */
export const REDACTED = "[redacted]";

/** Placeholder for values nested deeper than {@link MAX_DEPTH}. */
export const MAX_DEPTH_MARKER = "[max-depth]";

/** Placeholder for circular references. */
export const CIRCULAR_MARKER = "[circular]";

/**
 * Maximum object/array nesting depth serialized into a log line. Values
 * nested deeper are replaced with {@link MAX_DEPTH_MARKER}.
 */
export const MAX_DEPTH = 8;

export interface CreateLoggerOptions {
  /** Which worker/app is logging: `"api"`, `"pipeline"`, `"dashboard"`, … */
  worker: string;
  /** The request/trace id propagated across execution contexts. */
  requestId: string;
  /** Tenant the work belongs to, when known. */
  practiceId?: string | undefined;
  /** Pipeline stage or route name, when known. */
  stage?: string | undefined;
  /**
   * Minimum level emitted. Defaults to `"info"`; pass
   * `logLevelFor(env.ENVIRONMENT)` to enable `debug` in local dev only.
   */
  level?: LogLevel | undefined;
  /**
   * Escape hatch: field keys (matched at any depth) that are exempt from
   * PII redaction. Every use MUST carry a code comment explaining why the
   * field is safe to log.
   */
  allowUnsafe?: readonly string[] | undefined;
  /** Output seam, defaulting to `console.log`. Tests inject a capture. */
  sink?: ((line: string) => void) | undefined;
}

export interface Logger {
  /** The request id this logger is bound to. */
  readonly requestId: string;
  /** The minimum level this logger emits. */
  readonly level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /**
   * Returns a logger with `fields` bound to every line. `practiceId` and
   * `stage` keys update the canonical top-level fields; everything else is
   * merged into the extra fields. `opts.allowUnsafe` ADDS to the parent's
   * allowlist (same code-comment rule as `createLogger`).
   */
  child(fields: LogFields, opts?: { allowUnsafe?: readonly string[] }): Logger;
}

/**
 * Log level policy from the environment (`packages/core` env validation):
 * `debug` is compiled out everywhere except local dev.
 */
export function logLevelFor(environment: string | undefined): LogLevel {
  return environment === "local" ? "debug" : "info";
}

/** Canonical header carrying the request id in and out of HTTP edges. */
export const REQUEST_ID_HEADER = "x-request-id";

// Accepted inbound ids: short, printable, and log-safe. Anything else (log
// injection, absurd lengths) is discarded and a fresh id is minted.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Resolves the request id at an HTTP edge: the first well-formed candidate
 * wins (pass inbound `x-request-id` first, then `cf-ray`), otherwise a
 * fresh UUID is minted. Malformed candidates never pass through into logs.
 */
export function resolveRequestId(
  ...candidates: Array<string | null | undefined>
): string {
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined) {
      const trimmed = candidate.trim();
      if (SAFE_REQUEST_ID.test(trimmed)) return trimmed;
    }
  }
  return crypto.randomUUID();
}

/**
 * Deep-sanitizes a value for logging: redacts PII-suspect keys (minus the
 * allowlist), caps nesting depth, guards against circular references, and
 * normalizes non-JSON values (Error, Date, bigint). Exported for reuse by
 * anything that must serialize untrusted structures into a log-safe shape.
 */
export function sanitizeForLog(
  value: unknown,
  allowUnsafe: ReadonlySet<string> = new Set(),
): unknown {
  return sanitizeValue(value, 1, new Set(), allowUnsafe);
}

function sanitizeValue(
  value: unknown,
  depth: number,
  seen: Set<object>,
  allow: ReadonlySet<string>,
): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    default:
      break;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    // Constructed here, not key-redacted: `kind`/`message`/`stack` are the
    // error's own metadata. Never put PII in error messages.
    return {
      kind: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  const obj = value as object;
  if (seen.has(obj)) return CIRCULAR_MARKER;
  if (depth > MAX_DEPTH) return MAX_DEPTH_MARKER;
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map(
        (item) => sanitizeValue(item, depth + 1, seen, allow) ?? null,
      );
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(obj)) {
      if (PII_KEY_PATTERN.test(key) && !allow.has(key)) {
        out[key] = REDACTED;
        continue;
      }
      const sanitized = sanitizeValue(entry, depth + 1, seen, allow);
      if (sanitized !== undefined) out[key] = sanitized;
    }
    return out;
  } finally {
    // Delete on the way out so shared (non-circular) references still
    // serialize; only true cycles hit the marker.
    seen.delete(obj);
  }
}

interface BoundContext {
  worker: string;
  requestId: string;
  practiceId: string | undefined;
  stage: string | undefined;
  extra: LogFields;
  level: LogLevel;
  allowUnsafe: ReadonlySet<string>;
  sink: (line: string) => void;
}

/**
 * Creates a logger bound to a worker + request. See the module header for
 * the emitted shape and the redaction contract.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  return loggerFrom({
    worker: options.worker,
    requestId: options.requestId,
    practiceId: options.practiceId,
    stage: options.stage,
    extra: {},
    level: options.level ?? "info",
    allowUnsafe: new Set(options.allowUnsafe ?? []),
    // This module IS the console transport (issue #64): packages/core sits
    // outside the Biome noConsole override that bans raw console elsewhere.
    sink: options.sink ?? ((line) => console.log(line)),
  });
}

function loggerFrom(context: BoundContext): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[context.level]) return;
    const record: Record<string, unknown> = {
      level,
      ts: new Date().toISOString(),
      msg,
      worker: context.worker,
      requestId: context.requestId,
    };
    if (context.practiceId !== undefined) {
      record.practiceId = context.practiceId;
    }
    if (context.stage !== undefined) record.stage = context.stage;
    const merged = { ...context.extra, ...fields };
    const sanitized = sanitizeForLog(merged, context.allowUnsafe) as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(sanitized)) {
      // Bound/extra fields never clobber the canonical envelope keys.
      if (!(key in record)) record[key] = value;
    }
    context.sink(JSON.stringify(record));
  };

  return {
    requestId: context.requestId,
    level: context.level,
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields, opts) => {
      const { practiceId, stage, ...rest } = fields;
      return loggerFrom({
        ...context,
        practiceId:
          typeof practiceId === "string" ? practiceId : context.practiceId,
        stage: typeof stage === "string" ? stage : context.stage,
        extra: { ...context.extra, ...rest },
        allowUnsafe: opts?.allowUnsafe
          ? new Set([...context.allowUnsafe, ...opts.allowUnsafe])
          : context.allowUnsafe,
      });
    },
  };
}
