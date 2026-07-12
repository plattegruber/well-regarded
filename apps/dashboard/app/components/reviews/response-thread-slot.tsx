// ResponseThreadSlot — the review detail's response area (#77), and THE
// mounting seam for the composer (#79) and the approval workflow (#80).
//
// Contract, so the three issues compose without rework:
//
// - `entries` is the read-only history: all `responses` rows for the
//   signal, newest first, already formatted by the loader. The `responses`
//   table is #80's work; until it lands the loader passes `[]` and this
//   component renders the honest empty state ("no response recorded") —
//   never a fake draft or a disabled form.
// - `composer` is #79's slot: the compose form mounts BELOW the history,
//   inside this component, by being passed as this prop. Nothing else in
//   the detail route moves when it arrives.
// - `sourceNote` carries source-specific honesty copy (e.g. Google replies
//   made outside Well Regarded are not captured yet — see the route's
//   loader for the finding on `sourceMetadata.existingReply`).

import type { ReviewResponseStatus } from "@wellregarded/core";
import {
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_TONES,
} from "~/components/reviews/labels";
import { Overline } from "~/components/shell/page-header";
import { Badge } from "~/components/ui/badge";
import { Card } from "~/components/ui/card";

/** One rendered thread entry — display-ready strings only. */
export interface ResponseThreadEntryView {
  id: string;
  /** Inbox-vocabulary status for the chip. */
  status: ReviewResponseStatus;
  body: string;
  authorName: string | null;
  createdOn: string;
  publishedOn: string | null;
  publishedUrl: string | null;
}

export interface ResponseThreadSlotProps {
  entries: ResponseThreadEntryView[];
  /** #79 mounts the composer here; omit and only the history renders. */
  composer?: React.ReactNode;
  /** Optional source-honesty line rendered under the history. */
  sourceNote?: string;
}

export function ResponseThreadSlot({
  entries,
  composer,
  sourceNote,
}: ResponseThreadSlotProps) {
  return (
    <Card title="Responses" data-testid="response-thread">
      {entries.length === 0 ? (
        <p className="m-0 text-small text-gray-600">
          No response recorded yet. Drafts written here go through approval
          before anything publishes.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {entries.map((entry, index) => (
            <div
              key={entry.id}
              data-testid="response-entry"
              className={
                index > 0 ? "border-t border-hairline pt-4" : undefined
              }
            >
              <div className="mb-2 flex flex-wrap items-center gap-2.5">
                <Badge tone={REVIEW_STATUS_TONES[entry.status]}>
                  {REVIEW_STATUS_LABELS[entry.status]}
                </Badge>
                <Overline>
                  {entry.authorName
                    ? `${entry.authorName} · ${entry.createdOn}`
                    : entry.createdOn}
                </Overline>
              </div>
              <p className="m-0 whitespace-pre-wrap text-small text-ink-800">
                {entry.body}
              </p>
              {entry.publishedOn && (
                <p className="mt-2 mb-0 font-mono text-label text-gray-500">
                  Published {entry.publishedOn}
                  {entry.publishedUrl && (
                    <>
                      {" · "}
                      <a
                        href={entry.publishedUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-link"
                      >
                        View at source
                      </a>
                    </>
                  )}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      {sourceNote && (
        <p className="mt-4 mb-0 border-t border-hairline pt-3 text-small text-gray-500">
          {sourceNote}
        </p>
      )}
      {composer && <div className="mt-5">{composer}</div>}
    </Card>
  );
}
