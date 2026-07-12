/**
 * Integration coverage for the Today-queue helpers (issue #95): each
 * condition seeded at least once in one practice, asserting presence,
 * within-category ordering, caps + accurate totals, permission/privacy
 * gates — and that a practice with nothing going on returns empty
 * everywhere (the warm empty state is a data condition, not UI).
 */

import { isNegativeReview, type Sentiment } from "@wellregarded/core";
import { describe, expect, it } from "vitest";

import {
  derivation,
  importRun,
  practice,
  signal,
  sourceConnection,
} from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import {
  listFailedImports,
  listNegativeReviewsNeedingResponse,
  listReauthConnections,
  listRunningImports,
  listUrgentSignals,
} from "./today.js";

const t = setupTestDb();

const day = (n: number) =>
  new Date(`2026-06-${String(n).padStart(2, "0")}T12:00:00Z`);

describe("today queue helpers (integration)", () => {
  it("connections needing re-auth: only needs_reauth rows", async () => {
    const p = await practice(t.db);
    const broken = await sourceConnection(t.db, {
      practiceId: p.id,
      status: "needs_reauth",
    });
    // Active connections (other practices' too) never surface.
    await sourceConnection(t.db, { status: "active" });

    const rows = await listReauthConnections(t.db, p.id);
    expect(rows.map((row) => row.id)).toEqual([broken.id]);
  });

  it("urgent signals: severity desc then oldest first; manual downgrade clears; private gated", async () => {
    const p = await practice(t.db);
    const urgent = async (
      urgency: string,
      occurredAt: Date,
      visibility: "public" | "private" = "public",
    ) => {
      const s = await signal(t.db, {
        practiceId: p.id,
        visibility,
        occurredAt,
      });
      await derivation(t.db, {
        signalId: s.id,
        practiceId: p.id,
        dimension: "urgency",
        value: urgency,
        basis: "inferred_text",
      });
      return s;
    };

    const highOld = await urgent("high", day(1));
    const highNew = await urgent("high", day(10));
    const critical = await urgent("critical", day(20));
    const privateCritical = await urgent("critical", day(2), "private");
    await urgent("medium", day(3)); // below the routing threshold — resting
    // Manually downgraded (#93): the manual row outranks the inferred
    // `critical`, so the card clears — the interim resolve path.
    const downgraded = await urgent("critical", day(4));
    await derivation(t.db, {
      signalId: downgraded.id,
      practiceId: p.id,
      dimension: "urgency",
      value: "low",
      basis: "manual",
      confidence: 1,
      modelVersion: null,
    });

    const full = await listUrgentSignals(t.db, {
      practiceId: p.id,
      viewPrivateFeedback: true,
    });
    // Critical first (oldest critical first), then high oldest-first.
    expect(full.items.map((item) => item.id)).toEqual([
      privateCritical.id,
      critical.id,
      highOld.id,
      highNew.id,
    ]);
    expect(full.total).toBe(4);
    expect(full.items[0]?.urgency).toBe("critical");

    // Without view_private_feedback the private urgency stays unseen.
    const publicOnly = await listUrgentSignals(t.db, {
      practiceId: p.id,
      viewPrivateFeedback: false,
    });
    expect(publicOnly.items.map((item) => item.id)).toEqual([
      critical.id,
      highOld.id,
      highNew.id,
    ]);
    expect(publicOnly.total).toBe(3);
  });

  it("negative reviews: the shared tier-1 predicate, oldest first, capped with true totals", async () => {
    const p = await practice(t.db);
    const review = async (input: {
      rating: string | null;
      sentiment?: Sentiment;
      occurredAt: Date;
      visibility?: "public" | "private";
    }) => {
      const s = await signal(t.db, {
        practiceId: p.id,
        visibility: input.visibility ?? "public",
        originalRating: input.rating,
        occurredAt: input.occurredAt,
      });
      if (input.sentiment) {
        await derivation(t.db, {
          signalId: s.id,
          practiceId: p.id,
          dimension: "sentiment",
          value: input.sentiment,
          basis: "inferred_text",
        });
      }
      return s;
    };

    // Six that match: low ratings and negative sentiments, mixed.
    const matches = [
      await review({ rating: "1.0", occurredAt: day(1) }),
      await review({ rating: null, sentiment: "negative", occurredAt: day(2) }),
      await review({ rating: "2.0", sentiment: "mixed", occurredAt: day(3) }),
      await review({ rating: "1.0", occurredAt: day(4) }),
      await review({ rating: "2.0", occurredAt: day(5) }),
      await review({ rating: null, sentiment: "negative", occurredAt: day(6) }),
    ];
    // Non-matches: positive public, negative-but-private, unrated public,
    // and a low-rated NON-review source kind (feedback, not a review).
    await review({ rating: "5.0", sentiment: "positive", occurredAt: day(7) });
    await signal(t.db, {
      practiceId: p.id,
      visibility: "public",
      sourceKind: "firstparty",
      originalRating: "1.0",
      occurredAt: day(10),
    });
    await review({
      rating: "1.0",
      occurredAt: day(8),
      visibility: "private",
    });
    await review({ rating: null, occurredAt: day(9) });

    const section = await listNegativeReviewsNeedingResponse(t.db, {
      practiceId: p.id,
    });
    // Oldest first, capped at 5, with the accurate total behind the cap.
    expect(section.items.map((item) => item.id)).toEqual(
      matches.slice(0, 5).map((s) => s.id),
    );
    expect(section.total).toBe(6);

    // The SQL predicate agrees with the shared core function, row by row.
    for (const item of section.items) {
      expect(
        isNegativeReview({
          rating: item.rating === null ? null : Number(item.rating),
          sentiment: (item.sentiment as Sentiment | null) ?? null,
        }),
      ).toBe(true);
    }
  });

  it("imports: failed newest-first as action cards, running informational", async () => {
    const p = await practice(t.db);
    const failedOld = await importRun(t.db, {
      practiceId: p.id,
      status: "failed",
      failed: 12,
      startedAt: day(1),
    });
    const failedNew = await importRun(t.db, {
      practiceId: p.id,
      status: "failed",
      failed: 3,
      startedAt: day(5),
    });
    const running = await importRun(t.db, {
      practiceId: p.id,
      status: "running",
      created: 40,
      startedAt: day(6),
    });
    await importRun(t.db, { practiceId: p.id, status: "completed" });
    await importRun(t.db, {
      practiceId: p.id,
      status: "completed_with_errors",
    });

    const failed = await listFailedImports(t.db, { practiceId: p.id });
    expect(failed.items.map((run) => run.id)).toEqual([
      failedNew.id,
      failedOld.id,
    ]);
    expect(failed.total).toBe(2);

    const runningSection = await listRunningImports(t.db, {
      practiceId: p.id,
    });
    expect(runningSection.items.map((run) => run.id)).toEqual([running.id]);
    expect(runningSection.total).toBe(1);
  });

  it("a practice with nothing going on is empty everywhere — the all-clear state", async () => {
    const p = await practice(t.db);
    // A resting signal with no urgency and a fine rating: still no cards.
    const s = await signal(t.db, {
      practiceId: p.id,
      visibility: "public",
      originalRating: "5.0",
    });
    await derivation(t.db, {
      signalId: s.id,
      practiceId: p.id,
      dimension: "sentiment",
      value: "positive",
      basis: "inferred_text",
    });
    await sourceConnection(t.db, { practiceId: p.id, status: "active" });
    await importRun(t.db, { practiceId: p.id, status: "completed" });

    const [reauth, urgentSection, negative, failed, running] =
      await Promise.all([
        listReauthConnections(t.db, p.id),
        listUrgentSignals(t.db, {
          practiceId: p.id,
          viewPrivateFeedback: true,
        }),
        listNegativeReviewsNeedingResponse(t.db, { practiceId: p.id }),
        listFailedImports(t.db, { practiceId: p.id }),
        listRunningImports(t.db, { practiceId: p.id }),
      ]);
    expect(reauth).toEqual([]);
    expect(urgentSection).toEqual({ items: [], total: 0 });
    expect(negative).toEqual({ items: [], total: 0 });
    expect(failed).toEqual({ items: [], total: 0 });
    expect(running).toEqual({ items: [], total: 0 });
  });
});
