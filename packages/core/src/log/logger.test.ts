import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CIRCULAR_MARKER,
  type CreateLoggerOptions,
  createLogger,
  logLevelFor,
  MAX_DEPTH,
  MAX_DEPTH_MARKER,
  REDACTED,
  resolveRequestId,
  sanitizeForLog,
} from "./logger.js";

/** A logger whose lines are captured (and parsed) instead of printed. */
function captured(options: Partial<CreateLoggerOptions> = {}) {
  const lines: string[] = [];
  const log = createLogger({
    worker: "test",
    requestId: "req-1",
    sink: (line) => lines.push(line),
    ...options,
  });
  return {
    log,
    lines,
    last: () => JSON.parse(lines[lines.length - 1] ?? "null"),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("emitted shape", () => {
  it("emits a single JSON line with the canonical fields", () => {
    const { log, lines, last } = captured({ practiceId: "prac-1" });
    log.info("hello", { signalId: "sig-1" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(last()).toMatchObject({
      level: "info",
      msg: "hello",
      worker: "test",
      requestId: "req-1",
      practiceId: "prac-1",
      signalId: "sig-1",
    });
    expect(new Date(last().ts).toISOString()).toBe(last().ts);
  });

  it("omits practiceId and stage when unknown", () => {
    const { log, last } = captured();
    log.info("hello");
    expect("practiceId" in last()).toBe(false);
    expect("stage" in last()).toBe(false);
  });

  it("defaults the sink to console.log", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    createLogger({ worker: "test", requestId: "req-1" }).info("to console");
    expect(spy).toHaveBeenCalledOnce();
    expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toMatchObject({
      msg: "to console",
      requestId: "req-1",
    });
  });

  it("never lets extra fields clobber the canonical envelope keys", () => {
    const { log, last } = captured();
    log.info("hello", { requestId: "spoofed", level: "debug", msg: "nope" });
    expect(last().requestId).toBe("req-1");
    expect(last().level).toBe("info");
    expect(last().msg).toBe("hello");
  });

  it("serializes Error values as {kind, message, stack}", () => {
    const { log, last } = captured();
    log.error("boom", { error: new TypeError("bad input") });
    expect(last().error).toMatchObject({
      kind: "TypeError",
      message: "bad input",
    });
    expect(typeof last().error.stack).toBe("string");
  });
});

describe("redaction by default", () => {
  it("redacts a phone number logged at the top level", () => {
    const { log, last } = captured();
    log.info("contact", { phone: "+1 555 0100" });
    expect(last().phone).toBe(REDACTED);
    expect(JSON.stringify(last())).not.toContain("555 0100");
  });

  it("redacts nested PII keys: { patient: { phone } }", () => {
    const { log, last } = captured();
    log.info("contact", { patient: { phone: "+1 555 0100", id: "p-1" } });
    expect(last().patient).toEqual({ phone: REDACTED, id: "p-1" });
  });

  it.each([
    "phone",
    "email",
    "displayName",
    "originalText",
    "authToken",
    "body",
    "content",
  ])("redacts key %s", (key) => {
    const { log, last } = captured();
    log.info("x", { [key]: "sensitive" });
    expect(last()[key]).toBe(REDACTED);
  });

  it("matches keys case-insensitively", () => {
    const { log, last } = captured();
    log.info("x", { Email: "a@b.c", PHONE_NUMBER: "555" });
    expect(last().Email).toBe(REDACTED);
    expect(last().PHONE_NUMBER).toBe(REDACTED);
  });

  it("redacts the whole subtree when a matching key holds an object", () => {
    const { log, last } = captured();
    log.info("x", { body: { anything: "at all" } });
    expect(last().body).toBe(REDACTED);
  });

  it("redacts inside arrays of objects", () => {
    const { log, last } = captured();
    log.info("x", { patients: [{ phone: "555" }, { phone: "556" }] });
    expect(last().patients).toEqual([{ phone: REDACTED }, { phone: REDACTED }]);
  });

  it("leaves non-matching keys alone", () => {
    const { log, last } = captured();
    log.info("x", { signalId: "sig-1", count: 3, ok: true });
    expect(last()).toMatchObject({ signalId: "sig-1", count: 3, ok: true });
  });
});

describe("allowUnsafe escape hatch", () => {
  it("passes through an allowlisted key, still redacting others", () => {
    const { log, last } = captured({
      // Test-only: proving the escape hatch works end to end.
      allowUnsafe: ["sourceName"],
    });
    log.info("x", { sourceName: "google", email: "a@b.c" });
    expect(last().sourceName).toBe("google");
    expect(last().email).toBe(REDACTED);
  });

  it("applies the allowlist at any depth", () => {
    const { log, last } = captured({
      // Test-only: proving the escape hatch works end to end.
      allowUnsafe: ["sourceName"],
    });
    log.info("x", { nested: { sourceName: "google", phone: "555" } });
    expect(last().nested).toEqual({ sourceName: "google", phone: REDACTED });
  });

  it("child(opts.allowUnsafe) extends the parent allowlist", () => {
    const { log, lines } = captured({
      // Test-only: proving allowlist inheritance.
      allowUnsafe: ["sourceName"],
    });
    // Test-only: proving allowlist extension.
    const child = log.child({}, { allowUnsafe: ["queueName"] });
    child.info("x", { sourceName: "g", queueName: "wr-ingest", phone: "5" });
    const record = JSON.parse(lines[0] ?? "null");
    expect(record.sourceName).toBe("g");
    expect(record.queueName).toBe("wr-ingest");
    expect(record.phone).toBe(REDACTED);
  });
});

describe("depth cap and circular safety", () => {
  it("caps serialization depth", () => {
    // Build an object nested MAX_DEPTH + 2 levels deep.
    let value: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < MAX_DEPTH + 1; i++) {
      value = { deeper: value };
    }
    const { log, lines } = captured();
    log.info("deep", { value });
    expect(lines[0]).toContain(MAX_DEPTH_MARKER);
    expect(lines[0]).not.toContain("leaf");
  });

  it("survives circular structures instead of throwing", () => {
    const circular: { self?: unknown; signalId: string } = {
      signalId: "sig-1",
    };
    circular.self = circular;
    const { log, last } = captured();
    expect(() => log.info("circular", { circular })).not.toThrow();
    expect(last().circular).toEqual({
      signalId: "sig-1",
      self: CIRCULAR_MARKER,
    });
  });

  it("does not flag shared (non-circular) references as circular", () => {
    const shared = { signalId: "sig-1" };
    const { log, last } = captured();
    log.info("shared", { a: shared, b: shared });
    expect(last().a).toEqual({ signalId: "sig-1" });
    expect(last().b).toEqual({ signalId: "sig-1" });
  });

  it("normalizes non-JSON values (bigint, Date, undefined)", () => {
    const { log, last } = captured();
    log.info("odd", {
      big: 10n,
      when: new Date("2026-07-11T00:00:00Z"),
      missing: undefined,
    });
    expect(last().big).toBe("10");
    expect(last().when).toBe("2026-07-11T00:00:00.000Z");
    expect("missing" in last()).toBe(false);
  });
});

describe("level filtering", () => {
  it("suppresses debug at the default info level", () => {
    const { log, lines } = captured();
    log.debug("invisible");
    log.info("visible");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "null").msg).toBe("visible");
  });

  it("emits debug when the level is debug", () => {
    const { log, lines } = captured({ level: "debug" });
    log.debug("visible");
    expect(lines).toHaveLength(1);
  });

  it("suppresses info and warn at the error level", () => {
    const { log, lines } = captured({ level: "error" });
    log.info("no");
    log.warn("no");
    log.error("yes");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "null").level).toBe("error");
  });

  it("logLevelFor enables debug only in local", () => {
    expect(logLevelFor("local")).toBe("debug");
    expect(logLevelFor("preview")).toBe("info");
    expect(logLevelFor("prod")).toBe("info");
    expect(logLevelFor(undefined)).toBe("info");
  });
});

describe("child loggers", () => {
  it("binds extra fields onto every subsequent line", () => {
    const { log, last } = captured();
    const child = log.child({ stage: "dedupe", importRunId: "run-1" });
    child.info("working");
    expect(last()).toMatchObject({
      stage: "dedupe",
      importRunId: "run-1",
      requestId: "req-1",
    });
  });

  it("lets per-call fields override bound extras", () => {
    const { log, last } = captured();
    const child = log.child({ attempt: 1 });
    child.info("retry", { attempt: 2 });
    expect(last().attempt).toBe(2);
  });

  it("child practiceId updates the canonical field", () => {
    const { log, last } = captured();
    log.child({ practiceId: "prac-9" }).info("scoped");
    expect(last().practiceId).toBe("prac-9");
  });

  it("redacts bound fields too", () => {
    const { log, last } = captured();
    log.child({ email: "a@b.c" }).info("bound");
    expect(last().email).toBe(REDACTED);
  });

  it("does not mutate the parent", () => {
    const { log, last } = captured();
    log.child({ stage: "dedupe" });
    log.info("parent");
    expect("stage" in last()).toBe(false);
  });
});

describe("resolveRequestId", () => {
  it("prefers the first well-formed candidate", () => {
    expect(resolveRequestId("abc-123", "ray-1")).toBe("abc-123");
  });

  it("falls back to the next candidate when the first is malformed", () => {
    expect(resolveRequestId("bad value\nwith newline", "ray-1")).toBe("ray-1");
  });

  it("mints a UUID when no candidate is usable", () => {
    const id = resolveRequestId(null, undefined, "x".repeat(200));
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("sanitizeForLog", () => {
  it("is exported for reuse and redacts standalone structures", () => {
    expect(sanitizeForLog({ phone: "555", ok: 1 })).toEqual({
      phone: REDACTED,
      ok: 1,
    });
  });
});
