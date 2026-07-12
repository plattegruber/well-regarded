// PublishFailureCard (#82 requirement 4): a failed publish must be LOUD —
// the failed chip, the stored error in plain language (auth failures point
// at the re-auth surface), and the permission-gated Retry button that
// sends the response back to `approved` via the state machine and
// re-enqueues. Moderation rejections get no Retry: Google refused the
// content, the text needs a human rewrite (back through reject → draft).
import type { ResponseErrorDetail } from "@wellregarded/core";
import { describeResponseError, responseErrorClass } from "@wellregarded/core";
import { useFetcher } from "react-router";

import { Button } from "~/components/ui/button";

export function PublishFailureCard({
  responseId,
  errorDetail,
  canRetry,
  action,
}: {
  responseId: string;
  errorDetail: ResponseErrorDetail | null;
  /** `approve_response` — the same permission as approving (#82 req 5). */
  canRetry: boolean;
  /** POST target — the responses action route; defaults to the current route. */
  action?: string;
}) {
  const fetcher = useFetcher();
  const pending = fetcher.state !== "idle";
  const errorClass = errorDetail
    ? responseErrorClass(errorDetail)
    : "permanent";
  const retryable = canRetry && errorClass !== "content";

  return (
    <div
      className="flex flex-col gap-2 border-l-2 border-status-negative bg-status-negative-bg p-3"
      data-testid="publish-failure"
      data-error-class={errorClass}
    >
      <p className="m-0 text-small text-status-negative">
        {errorDetail
          ? describeResponseError(errorDetail)
          : "Publishing failed."}
      </p>
      {retryable && (
        <fetcher.Form method="post" action={action}>
          <input type="hidden" name="intent" value="retry-publish" />
          <input type="hidden" name="responseId" value={responseId} />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={pending}
            data-testid="retry-publish"
          >
            Retry publishing
          </Button>
        </fetcher.Form>
      )}
    </div>
  );
}
