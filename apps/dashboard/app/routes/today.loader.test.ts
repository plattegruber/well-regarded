// The Today loader (#95): every condition present renders its cards in
// exactly the documented order with accurate "N more" counts; permission
// variance hides sections whose target action the viewer cannot take;
// and with nothing to show the loader returns zero sections — the warm
// empty state is a data condition. The db helpers themselves are
// integration-tested in packages/db (queries/today.integration.test.ts);
// here they are mocked and the loader's assembly is the unit under test.
import type { StaffActor } from "@wellregarded/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listReauthConnections = vi.hoisted(() => vi.fn());
const listUrgentSignals = vi.hoisted(() => vi.fn());
const listNegativeReviewsNeedingResponse = vi.hoisted(() => vi.fn());
const listFailedImports = vi.hoisted(() => vi.fn());
const listRunningImports = vi.hoisted(() => vi.fn());
const listFailedPublishes = vi.hoisted(() => vi.fn());
const listResponsesPendingApproval = vi.hoisted(() => vi.fn());
const practiceAiStatus = vi.hoisted(() => vi.fn());
const requirePracticeContext = vi.hoisted(() => vi.fn());

vi.mock("@wellregarded/db", () => ({
  TODAY_SECTION_LIMIT: 5,
  listFailedImports,
  listFailedPublishes,
  listNegativeReviewsNeedingResponse,
  listReauthConnections,
  listResponsesPendingApproval,
  listRunningImports,
  listUrgentSignals,
  practiceAiStatus,
}));
vi.mock("~/lib/ai.server", () => ({
  aiConfigEnv: () => ({
    PIPELINE_MODEL: "claude-haiku-4-5-20251001",
    DRAFTING_MODEL: "claude-sonnet-5",
  }),
}));
vi.mock("~/lib/db.server", () => ({
  withRequestDb: (_context: unknown, fn: (db: unknown) => Promise<unknown>) =>
    fn({}),
}));
vi.mock("~/lib/practice-context.server", () => ({ requirePracticeContext }));

import { loader } from "./today";

const PRACTICE_ID = "0f9619ff-8b86-4d01-b42d-00cf4fc964ff";

function practiceContext(role: StaffActor["role"]) {
  const actor: StaffActor = {
    type: "staff",
    staffId: "3f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    practiceId: PRACTICE_ID,
    role,
    locationId: null,
  };
  return {
    practiceId: PRACTICE_ID,
    actor,
    auditActor: { type: "staff" as const, id: actor.staffId },
    viewer: { viewPrivateFeedback: true, viewPatientIdentity: true },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: route arg typing is generated per-route; the test erases it
const args = {
  context: { cloudflare: { env: { ENVIRONMENT: "local" } } },
  params: {},
  request: new Request("http://x/today"),
} as any;

const empty = { items: [], total: 0 };

function seedEverything() {
  listReauthConnections.mockResolvedValue([
    { id: "conn-1", lastSyncAt: new Date("2026-07-01T00:00:00Z") },
  ]);
  listUrgentSignals.mockResolvedValue({
    items: [
      {
        id: "sig-critical",
        sourceKind: "manual",
        visibility: "private",
        occurredAt: new Date("2026-07-01T00:00:00Z"),
        text: "Patient reports increasing pain after an extraction.",
        urgency: "critical",
      },
      {
        id: "sig-high",
        sourceKind: "google",
        visibility: "public",
        occurredAt: new Date("2026-07-02T00:00:00Z"),
        text: null,
        urgency: "high",
      },
    ],
    total: 8,
  });
  listNegativeReviewsNeedingResponse.mockResolvedValue({
    items: [
      {
        id: "rev-1",
        sourceKind: "google",
        occurredAt: new Date("2026-06-20T00:00:00Z"),
        text: "Waited an hour past my appointment time.",
        rating: "2.0",
        sentiment: "negative",
      },
    ],
    total: 1,
  });
  listFailedImports.mockResolvedValue({
    items: [
      {
        id: "run-failed",
        sourceKind: "csv_import",
        status: "failed",
        failed: 12,
        created: 0,
        merged: 0,
        skipped: 0,
        startedAt: new Date("2026-07-09T00:00:00Z"),
      },
    ],
    total: 1,
  });
  listRunningImports.mockResolvedValue({
    items: [
      {
        id: "run-running",
        sourceKind: "google",
        status: "running",
        failed: 0,
        created: 40,
        merged: 2,
        skipped: 1,
        startedAt: new Date("2026-07-10T00:00:00Z"),
      },
    ],
    total: 1,
  });
  listFailedPublishes.mockResolvedValue({
    items: [
      {
        responseId: "resp-failed",
        signalId: "sig-review",
        body: "Thank you for the kind words!",
        errorDetail: {
          kind: "needs_reauth",
          at: "2026-07-10T00:00:00.000Z",
        },
        failedAt: new Date("2026-07-10T00:00:00Z"),
        sourceUrl: "https://maps.example/r/1",
      },
    ],
    total: 1,
  });
  listResponsesPendingApproval.mockResolvedValue({
    items: [
      {
        responseId: "resp-pending",
        signalId: "sig-review-2",
        body: "We appreciate the feedback.",
        authorName: "Jordan Michaels",
        submittedAt: new Date("2026-07-09T00:00:00Z"),
      },
    ],
    total: 3,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePracticeContext.mockResolvedValue(practiceContext("owner"));
  listReauthConnections.mockResolvedValue([]);
  listUrgentSignals.mockResolvedValue(empty);
  listNegativeReviewsNeedingResponse.mockResolvedValue(empty);
  listFailedImports.mockResolvedValue(empty);
  listRunningImports.mockResolvedValue(empty);
  listFailedPublishes.mockResolvedValue(empty);
  listResponsesPendingApproval.mockResolvedValue(empty);
});

describe("today loader", () => {
  it("renders every condition's cards in exactly the documented order", async () => {
    seedEverything();
    const data = await loader(args);
    expect(data.sections.map((section) => section.key)).toEqual([
      "reauth",
      "urgent",
      "failed-imports",
      "failed-publishes",
      "pending-approvals",
      "negative-reviews",
      "running-imports",
    ]);

    // Each card is one clear action into the owning surface.
    const [
      reauth,
      urgent,
      failed,
      failedPublish,
      pendingApproval,
      negative,
      running,
    ] = data.sections;
    expect(failedPublish?.cards[0]).toMatchObject({
      tag: "Publish failed",
      tone: "negative",
      cta: "Review & retry",
      to: "/reviews/sig-review",
    });
    // The auth error class reads as a re-auth pointer, not a raw code.
    expect(failedPublish?.cards[0]?.meta).toContain("re-authorization");
    expect(pendingApproval?.cards[0]).toMatchObject({
      tag: "Awaiting approval",
      cta: "Review & approve",
      to: "/reviews/sig-review-2",
    });
    expect(pendingApproval?.cards[0]?.meta).toContain("Jordan Michaels");
    // Accurate "N more": 3 pending, 1 shown.
    expect(pendingApproval?.more).toMatchObject({ count: 2 });
    expect(reauth?.cards[0]).toMatchObject({
      cta: "Reconnect",
      to: "/settings/integrations",
      tone: "negative",
    });
    expect(urgent?.cards.map((card) => card.id)).toEqual([
      "sig-critical",
      "sig-high",
    ]);
    expect(urgent?.cards[0]).toMatchObject({
      tag: "Urgent · critical",
      tone: "negative",
      cta: "View signal",
      to: "/signals/sig-critical",
    });
    // Accurate "N more" behind the cap: 8 total, 2 shown.
    expect(urgent?.more).toMatchObject({ count: 6 });
    expect(failed?.cards[0]).toMatchObject({
      tag: "Import failed",
      to: "/settings/imports",
    });
    expect(negative?.cards[0]).toMatchObject({
      tag: "2-star review",
      cta: "Respond",
      to: "/reviews/rev-1",
    });
    expect(negative?.more).toBeNull();
    expect(running?.cards[0]).toMatchObject({
      tag: "Import running",
      tone: "neutral",
    });
    expect(running?.cards[0]?.meta).toContain("43 processed so far");
  });

  it("hides sections whose target action the viewer cannot take", async () => {
    // marketing: draft_response allow, manage_settings deny — sees the
    // review card, never the settings-routed ones.
    requirePracticeContext.mockResolvedValue(practiceContext("marketing"));
    seedEverything();
    const data = await loader(args);
    expect(data.sections.map((section) => section.key)).toEqual([
      "urgent",
      "negative-reviews",
    ]);
    // The gated queries are never even fired — approve_response gates
    // the publish/approval sections (#82 req 5), denied for marketing.
    expect(listReauthConnections).not.toHaveBeenCalled();
    expect(listFailedImports).not.toHaveBeenCalled();
    expect(listRunningImports).not.toHaveBeenCalled();
    expect(listFailedPublishes).not.toHaveBeenCalled();
    expect(listResponsesPendingApproval).not.toHaveBeenCalled();
  });

  it("excludes the viewer's own drafts from the approval section", async () => {
    await loader(args);
    expect(listResponsesPendingApproval).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      {
        practiceId: PRACTICE_ID,
        excludeAuthorId: "3f9619ff-8b86-4d01-b42d-00cf4fc964ff",
      },
    );
  });

  it("passes the viewer's private-feedback gate into the urgent query", async () => {
    await loader(args);
    expect(listUrgentSignals).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      { practiceId: PRACTICE_ID, viewPrivateFeedback: true },
    );
  });

  it("returns zero sections when nothing needs attention", async () => {
    const data = await loader(args);
    expect(data.sections).toEqual([]);
    expect(data.overline).toBeTruthy();
  });
});
