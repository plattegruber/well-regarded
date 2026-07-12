// ResponseThread (#77's thread slot, workflow actions from #80/#82).
//
// SELF-CONTAINED ON PURPOSE: the review detail page (#77) and composer
// (#79) are being built concurrently. This component takes plain
// serializable props and posts its forms to the responses action route
// (`/reviews/:signalId/responses`) — see that route's header for the
// integration contract. Until #77 lands, the same route renders it
// standalone.
//
// Per row: status chip (+ honest moderation nuance), author + timestamps,
// body, the "Changes requested" comment for rejected drafts, published_at
// + the source link for published rows, the loud failure card with Retry
// for failed rows, and approve/reject for pending rows (permission-gated,
// self-approval on negatives structurally hidden).
import type { ResponseErrorDetail } from "@wellregarded/core";
import { useFetcher } from "react-router";

import { Overline } from "~/components/shell/page-header";
import { Button } from "~/components/ui/button";

import { ApprovalActions } from "./approval-actions";
import { PublishFailureCard } from "./publish-failure-card";
import { ResponseStatusChip } from "./response-status-chip";
import { SafetyFindingsList } from "./safety-findings";

export interface ResponseThreadItem {
  id: string;
  status: "draft" | "pending_approval" | "approved" | "published" | "failed";
  body: string;
  authorName: string;
  isAuthor: boolean;
  createdOn: string;
  updatedOn: string;
  rejectionComment: string | null;
  errorDetail: ResponseErrorDetail | null;
  moderationState: "PENDING" | "APPROVED" | "REJECTED" | null;
  publishedOn: string | null;
}

export interface ResponseThreadProps {
  items: ResponseThreadItem[];
  /** `signals.source_url` — the published reply's canonical home. */
  sourceUrl: string | null;
  reviewIsNegative: boolean;
  canDraft: boolean;
  canApprove: boolean;
}

/** The submit action's bounce payload (#79's compose-side safety gate). */
interface SubmitBounce {
  safety?: {
    level: "ok" | "warn" | "block";
    findings: Array<{
      code: string;
      reason: string;
      suggestion?: string | undefined;
      level: "info" | "warn" | "block";
    }>;
  };
  error?: string;
}

export function SubmitForApproval({
  responseId,
  action,
}: {
  responseId: string;
  /** POST target — the responses action route; defaults to the current route. */
  action?: string;
}) {
  const fetcher = useFetcher<SubmitBounce>();
  const pending = fetcher.state !== "idle";
  const safety = fetcher.data?.safety;
  const blocked = safety?.level === "block";
  const needsAck = safety?.level === "warn";
  return (
    <fetcher.Form
      method="post"
      action={action}
      className="flex flex-col gap-2 border-t border-hairline pt-3"
    >
      <input type="hidden" name="intent" value="submit-for-approval" />
      <input type="hidden" name="responseId" value={responseId} />
      {safety && safety.findings.length > 0 && (
        <div>
          <p className="m-0 mb-2 text-small font-medium text-ink-800">
            {blocked
              ? "This draft can't be submitted — the safety check found blocking issues:"
              : "The safety check found warnings on this draft:"}
          </p>
          <SafetyFindingsList findings={safety.findings} />
        </div>
      )}
      {fetcher.data?.error && (
        <p className="m-0 text-small text-status-negative">
          {fetcher.data.error}
        </p>
      )}
      {needsAck && (
        <label className="flex items-start gap-2 text-small text-ink-800">
          <input
            type="checkbox"
            name="acknowledgeWarnings"
            value="yes"
            required
            className="mt-0.5"
            data-testid="acknowledge-warnings"
          />
          I reviewed the warnings above and want to submit anyway.
        </label>
      )}
      {!blocked && (
        <div>
          <Button type="submit" size="sm" disabled={pending}>
            Submit for approval
          </Button>
        </div>
      )}
    </fetcher.Form>
  );
}

export function ResponseThread({
  items,
  sourceUrl,
  reviewIsNegative,
  canDraft,
  canApprove,
}: ResponseThreadProps) {
  if (items.length === 0) {
    return (
      <p className="m-0 text-small text-gray-500" data-testid="response-thread">
        No responses yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="response-thread">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex flex-col gap-2.5 border border-hairline p-4"
          data-testid="response-thread-item"
          data-status={item.status}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ResponseStatusChip
              status={item.status}
              moderationState={item.moderationState}
            />
            <Overline>
              {item.authorName} · {item.createdOn}
            </Overline>
          </div>

          <p className="m-0 whitespace-pre-wrap text-small text-ink-800">
            {item.body}
          </p>

          {item.status === "draft" && item.rejectionComment && (
            <p
              className="m-0 border-l-2 border-status-caution py-1 pl-3 text-small text-gray-600"
              data-testid="rejection-comment"
            >
              Changes requested: {item.rejectionComment}
            </p>
          )}

          {item.status === "published" && (
            <p className="m-0 text-small text-gray-500">
              Published {item.publishedOn}
              {sourceUrl && (
                <>
                  {" · "}
                  <a
                    href={sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-link"
                  >
                    View on Google
                  </a>
                </>
              )}
            </p>
          )}

          {item.status === "failed" && (
            <PublishFailureCard
              responseId={item.id}
              errorDetail={item.errorDetail}
              canRetry={canApprove}
            />
          )}

          {item.status === "pending_approval" && (
            <ApprovalActions
              responseId={item.id}
              canApprove={canApprove}
              isAuthor={item.isAuthor}
              reviewIsNegative={reviewIsNegative}
            />
          )}

          {item.status === "draft" && canDraft && (
            <SubmitForApproval responseId={item.id} />
          )}
        </div>
      ))}
    </div>
  );
}
