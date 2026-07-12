// ApprovalActions (#80): approve / reject for a pending_approval response.
//
// - Approve re-runs the safety check SERVER-SIDE (the action); when the
//   fresh verdict is `warn`, the action bounces back (422, via this
//   component's fetcher) with the findings, and the explicit "I reviewed
//   the warnings" checkbox the state machine demands appears. A `block`
//   verdict renders the findings with no way through — blocks are edited
//   away, not waived.
// - Reject requires a comment (the state machine refuses without one);
//   the textarea is marked required so the browser catches the empty case
//   first, and the 400 handles the rest.
// - The approve affordance is HIDDEN (not disabled) for viewers who can't
//   act: no approve_response permission, or self-approval on a negative
//   review (the structural rule) — matching the repo's hidden-affordance
//   convention. The action re-checks everything; hiding is not security.
import { useFetcher } from "react-router";

import { Button } from "~/components/ui/button";

import { SafetyFindingsList, type SafetyNotice } from "./safety-findings";

/** The action's bounce payload for a refused approve (422). */
interface ApproveBounce {
  safety?: SafetyNotice;
  error?: string;
}

export function ApprovalActions({
  responseId,
  canApprove,
  isAuthor,
  reviewIsNegative,
  action,
}: {
  responseId: string;
  canApprove: boolean;
  isAuthor: boolean;
  reviewIsNegative: boolean;
  /** POST target — the responses action route; defaults to the current route. */
  action?: string;
}) {
  const fetcher = useFetcher<ApproveBounce>();
  const pending = fetcher.state !== "idle";
  const safetyNotice = fetcher.data?.safety;
  const selfBlockedOnNegative = reviewIsNegative && isAuthor;
  const showApprove = canApprove && !selfBlockedOnNegative;

  if (!canApprove) return null;

  return (
    <div
      className="flex flex-col gap-3 border-t border-hairline pt-3"
      data-testid="approval-actions"
    >
      {safetyNotice && safetyNotice.findings.length > 0 && (
        <div>
          <p className="m-0 mb-2 text-small font-medium text-ink-800">
            {safetyNotice.level === "block"
              ? "This response can't be approved — the safety check found blocking issues:"
              : "The safety check found warnings on the current text:"}
          </p>
          <SafetyFindingsList findings={safetyNotice.findings} />
        </div>
      )}
      {fetcher.data?.error && (
        <p className="m-0 text-small text-status-negative">
          {fetcher.data.error}
        </p>
      )}

      <div className="flex flex-wrap items-start gap-4">
        {showApprove && safetyNotice?.level !== "block" && (
          <fetcher.Form
            method="post"
            action={action}
            className="flex flex-col gap-2"
          >
            <input type="hidden" name="intent" value="approve" />
            <input type="hidden" name="responseId" value={responseId} />
            {safetyNotice?.needsAcknowledgement && (
              <label className="flex items-start gap-2 text-small text-ink-800">
                <input
                  type="checkbox"
                  name="acknowledgeWarnings"
                  value="yes"
                  required
                  className="mt-0.5"
                  data-testid="acknowledge-warnings"
                />
                I reviewed the warnings above and want to approve anyway.
              </label>
            )}
            <div>
              <Button type="submit" size="sm" disabled={pending}>
                Approve
              </Button>
            </div>
          </fetcher.Form>
        )}
        {selfBlockedOnNegative && (
          <p className="m-0 max-w-90 text-small text-gray-600">
            Responses to negative reviews must be approved by someone other than
            the author.
          </p>
        )}

        <fetcher.Form
          method="post"
          action={action}
          className="flex min-w-60 flex-1 flex-col gap-2"
        >
          <input type="hidden" name="intent" value="reject" />
          <input type="hidden" name="responseId" value={responseId} />
          <textarea
            name="comment"
            required
            rows={2}
            placeholder="What should change? (required to reject)"
            className="w-full border border-hairline bg-transparent p-2 text-small text-ink-800"
            data-testid="reject-comment"
          />
          <div>
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              disabled={pending}
            >
              Request changes
            </Button>
          </div>
        </fetcher.Form>
      </div>
    </div>
  );
}
