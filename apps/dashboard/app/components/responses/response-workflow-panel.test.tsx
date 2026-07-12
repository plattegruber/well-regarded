// Rendering tests for the workflow panel (#80/#82): per-status affordances,
// the structural self-approval hiding on negative reviews, the loud
// failure card with permission-gated Retry, and the content-class failure
// that gets no Retry (Google refused the text — a rewrite, not a retry).
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import {
  type LatestResponseView,
  ResponseWorkflowPanel,
} from "./response-workflow-panel";

const ACTION = "/reviews/8b0d3f8e-0000-4000-8000-000000000000/responses";

function latest(
  overrides: Partial<LatestResponseView> = {},
): LatestResponseView {
  return {
    id: "9c1d2e3f-0000-4000-8000-000000000001",
    status: "pending_approval",
    isAuthor: false,
    rejectionComment: null,
    errorDetail: null,
    ...overrides,
  };
}

function render(
  props: Partial<Parameters<typeof ResponseWorkflowPanel>[0]> = {},
): string {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ResponseWorkflowPanel
          latest={latest()}
          canDraft={true}
          canApprove={true}
          reviewIsNegative={false}
          action={ACTION}
          {...props}
        />
      ),
    },
  ]);
  return renderToString(<Stub initialEntries={["/"]} />);
}

describe("ResponseWorkflowPanel", () => {
  it("renders nothing without a response (the composer's job, #79)", () => {
    expect(render({ latest: null })).toBe("");
  });

  it("pending: approve and reject render for approvers, posting to the action route", () => {
    const html = render();
    expect(html).toContain("Approve");
    expect(html).toContain("Request changes");
    expect(html).toContain(ACTION);
  });

  it("pending + negative + author: the approve affordance is hidden, not disabled", () => {
    const html = render({
      latest: latest({ isAuthor: true }),
      reviewIsNegative: true,
    });
    expect(html).not.toContain(">Approve<");
    expect(html).toContain("someone other");
    // Reject stays available — requesting changes is not self-approval.
    expect(html).toContain("Request changes");
  });

  it("draft: shows the changes-requested comment and submit-for-approval", () => {
    const html = render({
      latest: latest({
        status: "draft",
        rejectionComment: "Please soften the tone.",
      }),
    });
    // SSR splits adjacent text nodes with a comment marker — assert parts.
    expect(html).toContain("Changes requested:");
    expect(html).toContain("Please soften the tone.");
    expect(html).toContain("Submit for approval");
  });

  it("failed (transient): loud error text plus the permission-gated Retry", () => {
    const detail = {
      kind: "transient_exhausted" as const,
      message: "HTTP 503",
      at: "2026-07-11T00:00:00.000Z",
    };
    const withRetry = render({
      latest: latest({ status: "failed", errorDetail: detail }),
    });
    expect(withRetry).toContain("Retry publishing");
    expect(withRetry).toContain("Google kept failing");

    const withoutPermission = render({
      latest: latest({ status: "failed", errorDetail: detail }),
      canApprove: false,
    });
    expect(withoutPermission).not.toContain("Retry publishing");
  });

  it("failed (moderation rejection): no Retry — the text needs a human", () => {
    const html = render({
      latest: latest({
        status: "failed",
        errorDetail: {
          kind: "moderation_rejected",
          policyViolation: "Off-topic content.",
          message: "",
          at: "2026-07-11T00:00:00.000Z",
        },
      }),
    });
    expect(html).toContain("Google rejected the reply");
    expect(html).not.toContain("Retry publishing");
  });

  it("approved: says publishing is underway; published: renders nothing", () => {
    expect(render({ latest: latest({ status: "approved" }) })).toContain(
      "publishing to Google",
    );
    expect(render({ latest: latest({ status: "published" }) })).toBe("");
  });
});
