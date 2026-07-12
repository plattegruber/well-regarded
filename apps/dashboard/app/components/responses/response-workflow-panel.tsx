// ResponseWorkflowPanel (#80/#82): the workflow actions for the LATEST
// response, built to mount in the review detail's `ResponseThreadSlot`
// `composer` slot (#77's seam) — the slot renders the read-only history,
// this panel renders what can be DONE next, and #79's composer form will
// sit beside it in the same slot when it lands.
//
// Every form posts to the responses action route
// (`/reviews/:signalId/responses`, pass it as `action`) so the detail
// route needs no action plumbing of its own.
//
// What renders, by the latest response's raw status:
// - draft            → the reject comment (when it came back) + Submit for
//                      approval (permission-gated).
// - pending_approval → approve/reject (safety gate + structural
//                      self-approval rules live in ApprovalActions).
// - approved         → a quiet "publishing…" line (the queue is at work).
// - failed           → the loud failure card + permission-gated Retry.
// - published        → nothing; the history already says it all.
import type { ResponseErrorDetail } from "@wellregarded/core";

import { ApprovalActions } from "./approval-actions";
import { PublishFailureCard } from "./publish-failure-card";
import { SubmitForApproval } from "./response-thread";

export interface LatestResponseView {
  id: string;
  status: "draft" | "pending_approval" | "approved" | "published" | "failed";
  isAuthor: boolean;
  rejectionComment: string | null;
  errorDetail: ResponseErrorDetail | null;
}

export function ResponseWorkflowPanel({
  latest,
  canDraft,
  canApprove,
  reviewIsNegative,
  action,
}: {
  /** The newest response row, or null when none exists yet (#79 drafts). */
  latest: LatestResponseView | null;
  canDraft: boolean;
  canApprove: boolean;
  reviewIsNegative: boolean;
  /** The responses action route: `/reviews/:signalId/responses`. */
  action: string;
}) {
  if (!latest) return null;

  switch (latest.status) {
    case "draft":
      return (
        <div
          className="flex flex-col gap-2.5"
          data-testid="response-workflow-panel"
        >
          {latest.rejectionComment && (
            <p
              className="m-0 border-l-2 border-status-caution py-1 pl-3 text-small text-gray-600"
              data-testid="rejection-comment"
            >
              Changes requested: {latest.rejectionComment}
            </p>
          )}
          {canDraft && (
            <SubmitForApproval responseId={latest.id} action={action} />
          )}
        </div>
      );
    case "pending_approval":
      return (
        <div data-testid="response-workflow-panel">
          <ApprovalActions
            responseId={latest.id}
            canApprove={canApprove}
            isAuthor={latest.isAuthor}
            reviewIsNegative={reviewIsNegative}
            action={action}
          />
        </div>
      );
    case "approved":
      return (
        <p
          className="m-0 text-small text-gray-500"
          data-testid="response-workflow-panel"
        >
          Approved — publishing to Google.
        </p>
      );
    case "failed":
      return (
        <div data-testid="response-workflow-panel">
          <PublishFailureCard
            responseId={latest.id}
            errorDetail={latest.errorDetail}
            canRetry={canApprove}
            action={action}
          />
        </div>
      );
    case "published":
      return null;
  }
}
