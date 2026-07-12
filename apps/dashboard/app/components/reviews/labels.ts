// Display vocabulary for the review surfaces (#76/#77) — sentence-case
// labels and Badge tones for the response-status chips, shared by the
// inbox rows, the tabs, the detail view, and their tests.
import type {
  ReviewResponseStatus,
  ReviewSourceKind,
} from "@wellregarded/core";

import type { BadgeProps } from "~/components/ui/badge";

/** The `source` filter's public labels (URL vocabulary in reviews-search). */
export const REVIEW_SOURCE_FILTER_LABELS: Record<
  "google" | "csv" | "manual",
  string
> = {
  google: "Google",
  csv: "CSV import",
  manual: "Manual entry",
};

export const REVIEW_STATUS_LABELS: Record<ReviewResponseStatus, string> = {
  needs_response: "Needs response",
  drafted: "Drafted",
  pending_approval: "Pending approval",
  responded: "Responded",
};

/** Color-coding for the four status chips (#76 requirement 5). */
export const REVIEW_STATUS_TONES: Record<
  ReviewResponseStatus,
  NonNullable<BadgeProps["tone"]>
> = {
  needs_response: "caution",
  drafted: "neutral",
  pending_approval: "gold",
  responded: "positive",
};

/** Detail-page titles per review source kind. */
export const REVIEW_SOURCE_TITLES: Record<ReviewSourceKind, string> = {
  google: "Google review",
  csv_import: "Imported review",
  manual: "Manually entered review",
};
