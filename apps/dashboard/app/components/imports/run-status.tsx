// Import-run status presentation (issue #137), shared by the imports list
// and the report page so the two can never disagree about what a status
// means or when a run counts as stale.
import type { ImportRunStatus } from "@wellregarded/core";

import { Badge } from "~/components/ui/badge";

/**
 * A `running` run older than this renders as "taking longer than
 * expected". Chosen ABOVE the CSV Workflow's 2h drain cap (#135): a run
 * this old has outlived every legitimate execution path, so the honest
 * reading is "something is wrong", not "still working".
 */
export const IMPORT_RUN_STALE_AFTER_MS = 3 * 60 * 60 * 1000;

export function isImportRunStale(
  status: ImportRunStatus,
  startedAt: Date,
  now: Date = new Date(),
): boolean {
  return (
    status === "running" &&
    now.getTime() - startedAt.getTime() > IMPORT_RUN_STALE_AFTER_MS
  );
}

export const IMPORT_RUN_STATUS_LABELS: Record<ImportRunStatus, string> = {
  running: "Running",
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
};

const STATUS_TONES: Record<
  ImportRunStatus,
  "neutral" | "positive" | "caution" | "negative"
> = {
  running: "neutral",
  completed: "positive",
  completed_with_errors: "caution",
  failed: "negative",
};

export interface RunStatusBadgeProps {
  status: ImportRunStatus;
  /** Renders the stale variant instead of a bare "Running". */
  stale?: boolean;
}

export function RunStatusBadge({ status, stale = false }: RunStatusBadgeProps) {
  if (status === "running" && stale) {
    return (
      <Badge tone="caution" data-testid="run-status" data-status="stale">
        Taking longer than expected
      </Badge>
    );
  }
  return (
    <Badge
      tone={STATUS_TONES[status]}
      data-testid="run-status"
      data-status={status}
    >
      {IMPORT_RUN_STATUS_LABELS[status]}
    </Badge>
  );
}
