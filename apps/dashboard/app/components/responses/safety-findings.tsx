// SafetyFindingsList (#80 requirement 6): renders `checkResponseSafety`
// findings the same way for the approve panel here and the composer (#79)
// — block findings red, warnings amber, and the degraded-mode
// `ai_check_skipped` notice as a quiet informational line. Pure props →
// markup; the caller runs the check.
import { cn } from "~/lib/utils";

/** The serializable slice of `SafetyFinding` the UI renders. */
export interface SafetyFindingView {
  code: string;
  reason: string;
  suggestion?: string | undefined;
  level: "info" | "warn" | "block";
}

export interface SafetyNotice {
  level: "ok" | "warn" | "block";
  findings: SafetyFindingView[];
  /** True when approval needs the explicit "reviewed the warnings" tick. */
  needsAcknowledgement: boolean;
}

export function SafetyFindingsList({
  findings,
}: {
  findings: SafetyFindingView[];
}) {
  if (findings.length === 0) return null;
  return (
    <ul
      className="m-0 flex list-none flex-col gap-2 p-0"
      data-testid="safety-findings"
    >
      {findings.map((finding) => (
        <li
          key={`${finding.code}:${finding.reason}`}
          className={cn(
            "border-l-2 py-1 pl-3 text-small",
            finding.level === "block" &&
              "border-status-negative text-status-negative",
            finding.level === "warn" &&
              "border-status-caution text-status-caution",
            finding.level === "info" && "border-gray-300 text-gray-500",
          )}
          data-level={finding.level}
        >
          <span className="font-medium">{finding.reason}</span>
          {finding.suggestion && (
            <span className="block text-gray-600">{finding.suggestion}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
