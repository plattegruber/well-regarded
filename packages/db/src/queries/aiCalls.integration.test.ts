import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { practice } from "../../test/factories.js";
import { pgError, setupTestDb } from "../../test/harness.js";
import { aiCalls } from "../schema/aiCalls.js";
import { createAiCallSink, logAiCall } from "./aiCalls.js";

describe("ai_calls cost logging (integration)", () => {
  const t = setupTestDb();

  it("writes one row with the exact tokens/latency the sink was handed", async () => {
    const p = await practice(t.db);
    const sink = createAiCallSink(t.db);

    await sink({
      practiceId: p.id,
      purpose: "judgments",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 812,
      outputTokens: 47,
      latencyMs: 391,
      error: null,
    });

    const rows = await t.db
      .select()
      .from(aiCalls)
      .where(eq(aiCalls.practiceId, p.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      practiceId: p.id,
      purpose: "judgments",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 812,
      outputTokens: 47,
      latencyMs: 391,
      error: null,
    });
    expect(rows[0]?.id).toBeTruthy();
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("accepts tenant-less rows (practice_id NULL) and records the error text", async () => {
    await logAiCall(t.db, {
      practiceId: null,
      purpose: "eval-run",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 100,
      outputTokens: 25,
      latencyMs: 120,
      error: "schema validation failed: sentiment: Invalid input",
    });

    const rows = await t.db.select().from(aiCalls);
    const evalRow = rows.find((row) => row.purpose === "eval-run");
    expect(evalRow?.practiceId).toBeNull();
    expect(evalRow?.error).toMatch(/schema validation failed/);
  });

  it("rejects rows pointing at a practice that does not exist (FK)", async () => {
    const { code } = await pgError(
      logAiCall(t.db, {
        practiceId: "00000000-0000-0000-0000-000000000000",
        purpose: "judgments",
        model: "claude-haiku-4-5-20251001",
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        error: null,
      }),
    );
    expect(code).toBe("23503"); // foreign_key_violation
  });
});
