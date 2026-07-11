/**
 * Judgment derivations against real Postgres (issue #67): the classify
 * consumer's write path — `judgmentsToDerivations`/`ratingOnlyDerivations`
 * from `@wellregarded/ai` mapped into `insertDerivations`, guarded by
 * `signalHasDerivations` — lands correct rows, resolves through
 * `getCurrentDerivations`, and a redelivered message writes nothing new.
 */

import {
  type JudgmentDerivation,
  type Judgments,
  judgmentsToDerivations,
  ratingOnlyDerivations,
} from "@wellregarded/ai";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { practice, signal } from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import { derivations } from "../schema/derivations.js";
import {
  getCurrentDerivations,
  insertDerivations,
  signalHasDerivations,
} from "./derivations.js";

const MODEL = "claude-haiku-4-5-20251001";

const judgments: Judgments = {
  sentiment: {
    value: "negative",
    confidence: 0.95,
    rationale: "Angry about ongoing pain after an extraction.",
  },
  urgency: {
    value: "medium",
    confidence: 0.4, // < 0.5 → the floor bumps the stored value to high
    rationale: "Possibly an unresolved complaint; hard to tell.",
  },
  response_risk: {
    value: "high",
    confidence: 0.8,
    rationale: "Names a procedure; a reply risks confirming care.",
  },
  publication_suitability: {
    value: "unsuitable",
    confidence: 0.9,
    rationale: "Health details the author may regret sharing.",
  },
};

describe("judgment derivations (integration)", () => {
  const t = setupTestDb();

  /** The same row mapping `createClassifyStore` in workers/pipeline uses. */
  function toInserts(
    signalId: string,
    practiceId: string,
    rows: readonly JudgmentDerivation[],
  ) {
    return rows.map((row) => ({
      signalId,
      practiceId,
      dimension: row.dimension,
      value: row.value,
      confidence: row.confidence,
      basis: row.basis,
      modelVersion: row.modelVersion,
      rationale: row.rationale,
    }));
  }

  it("writes four AI rows with basis, model_version, rationale, and the urgency floor applied", async () => {
    const s = await signal(t.db, {
      originalText: "Still in pain three days after my extraction.",
    });

    const rows = judgmentsToDerivations(judgments, MODEL);
    await insertDerivations(t.db, toInserts(s.id, s.practiceId, rows));

    const current = await getCurrentDerivations(t.db, s.id);
    expect(current.sentiment).toMatchObject({
      value: "negative",
      confidence: 0.95,
      basis: "inferred_text",
      modelVersion: MODEL,
      rationale: "Angry about ongoing pain after an extraction.",
    });
    // medium @ 0.4 → stored as high; the model's confidence is kept.
    expect(current.urgency).toMatchObject({
      value: "high",
      basis: "inferred_text",
      modelVersion: MODEL,
    });
    expect(current.urgency?.confidence).toBeCloseTo(0.4);
    expect(current.response_risk).toMatchObject({ value: "high" });
    expect(current.publication_suitability).toMatchObject({
      value: "unsuitable",
    });
  });

  it("is idempotent: the redelivery guard sees the first run and a guarded re-run adds nothing", async () => {
    const s = await signal(t.db, { originalText: "Some real feedback text." });

    expect(
      await signalHasDerivations(t.db, s.id, { modelVersion: MODEL }),
    ).toBe(false);

    const classifyOnce = async () => {
      if (await signalHasDerivations(t.db, s.id, { modelVersion: MODEL })) {
        return;
      }
      await insertDerivations(
        t.db,
        toInserts(s.id, s.practiceId, judgmentsToDerivations(judgments, MODEL)),
      );
    };

    await classifyOnce();
    await classifyOnce(); // redelivery

    const stored = await t.db
      .select()
      .from(derivations)
      .where(eq(derivations.signalId, s.id));
    expect(stored).toHaveLength(4);
  });

  it("scopes the model-version probe to the signal and the exact model id", async () => {
    const s = await signal(t.db, { originalText: "text one two three" });
    const other = await signal(t.db, {
      practiceId: s.practiceId,
      originalText: "different signal text",
    });
    await insertDerivations(
      t.db,
      toInserts(s.id, s.practiceId, judgmentsToDerivations(judgments, MODEL)),
    );

    expect(
      await signalHasDerivations(t.db, s.id, { modelVersion: MODEL }),
    ).toBe(true);
    expect(
      await signalHasDerivations(t.db, s.id, { modelVersion: "other-model" }),
    ).toBe(false);
    expect(
      await signalHasDerivations(t.db, other.id, { modelVersion: MODEL }),
    ).toBe(false);
    // A new model version is NOT blocked — reclassification appends.
    expect(
      await signalHasDerivations(t.db, s.id, { basis: "source_metadata" }),
    ).toBe(false);
  });

  it("writes three deterministic rows for rating-only signals and probes by basis", async () => {
    const p = await practice(t.db);
    const s = await signal(t.db, {
      practiceId: p.id,
      originalText: null,
      originalRating: "1.0",
    });

    await insertDerivations(
      t.db,
      toInserts(s.id, p.id, ratingOnlyDerivations(1)),
    );

    const current = await getCurrentDerivations(t.db, s.id);
    expect(current.sentiment).toMatchObject({
      value: "negative",
      confidence: 0.6,
      basis: "source_metadata",
      modelVersion: null,
    });
    expect(current.urgency).toMatchObject({ value: "low" });
    expect(current.publication_suitability).toMatchObject({
      value: "unsuitable",
    });
    expect(current.response_risk).toBeUndefined();

    expect(
      await signalHasDerivations(t.db, s.id, { basis: "source_metadata" }),
    ).toBe(true);
  });

  it("keeps a later manual correction ahead of the AI rows (ethical invariant #1)", async () => {
    const s = await signal(t.db, { originalText: "some feedback text here" });
    await insertDerivations(
      t.db,
      toInserts(s.id, s.practiceId, judgmentsToDerivations(judgments, MODEL)),
    );
    await insertDerivations(t.db, [
      {
        signalId: s.id,
        practiceId: s.practiceId,
        dimension: "urgency",
        value: "none",
        confidence: 1,
        basis: "manual",
        modelVersion: null,
        rationale: null,
      },
    ]);

    const current = await getCurrentDerivations(t.db, s.id);
    expect(current.urgency).toMatchObject({ value: "none", basis: "manual" });
  });
});
