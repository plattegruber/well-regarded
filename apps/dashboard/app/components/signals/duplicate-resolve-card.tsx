// DuplicateResolveCard (#90): a pending suspected-duplicate link from the
// pipeline's dedupe stage (Epic #6), presented for HUMAN review — the
// epic's hard rule is no silent merges. Two text blocks side by side (diff
// niceties are out of scope), and a resolve action: "same" confirms the
// link, "different" dismisses it; both are audited by the action.
//
// The buttons only render for viewers with `resolve_duplicates` —
// affordances the viewer lacks are hidden, not disabled.
import { useFetcher } from "react-router";

import { Overline } from "~/components/shell/page-header";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { RatingStars } from "~/components/ui/rating-stars";

export interface DuplicatePreview {
  sourceLabel: string;
  occurredOn: string;
  text: string | null;
  /** Numeric rating (source scale) or null. */
  rating: number | null;
}

export interface DuplicateCardData {
  /** The suspected_duplicates row id — the resolve action's target. */
  id: string;
  /** Plain-language similarity, e.g. "96% text similarity". */
  similarityLabel: string;
  other: DuplicatePreview & { signalId: string };
}

function Preview({
  heading,
  preview,
}: {
  heading: string;
  preview: DuplicatePreview;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Overline>{heading}</Overline>
      <p className="m-0 font-mono text-quote text-ink-800">
        {preview.text ?? "No text recorded."}
      </p>
      <div className="flex items-center gap-2.5 text-label text-gray-500">
        {preview.rating !== null && (
          <RatingStars rating={preview.rating} size={11} />
        )}
        <span className="font-mono">{preview.occurredOn}</span>
      </div>
    </div>
  );
}

export function DuplicateResolveCard({
  duplicate,
  current,
  canResolve,
}: {
  duplicate: DuplicateCardData;
  current: DuplicatePreview;
  canResolve: boolean;
}) {
  const fetcher = useFetcher();
  const pending = fetcher.state !== "idle";

  return (
    <Card title="Possible duplicate" data-testid="duplicate-resolve-card">
      <p className="mt-0 mb-4 text-small text-gray-600">
        The pipeline linked these for review — {duplicate.similarityLabel}. Both
        records are kept either way.
      </p>
      <div className="grid gap-5 border-t border-hairline pt-4 sm:grid-cols-2">
        <Preview
          heading={`This signal · ${current.sourceLabel}`}
          preview={current}
        />
        <Preview
          heading={`Candidate · ${duplicate.other.sourceLabel}`}
          preview={duplicate.other}
        />
      </div>
      {canResolve && (
        <fetcher.Form method="post" className="mt-4 flex gap-2.5">
          <input type="hidden" name="intent" value="resolve-duplicate" />
          <input type="hidden" name="duplicateId" value={duplicate.id} />
          <Button
            type="submit"
            name="resolution"
            value="same"
            variant="secondary"
            size="sm"
            disabled={pending}
          >
            Same event
          </Button>
          <Button
            type="submit"
            name="resolution"
            value="different"
            variant="secondary"
            size="sm"
            disabled={pending}
          >
            Different
          </Button>
        </fetcher.Form>
      )}
    </Card>
  );
}
