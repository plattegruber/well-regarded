// Step 2 of the mapping wizard (#134): the validation preview, rendered
// from `validateCsvPreviewRows` output — the same validator the import
// Workflow (#135) runs, so what this table promises is what the import
// does. Errors (row will be skipped) and warnings (row imports, minus a
// detail) are visually distinct and every message says what to fix.
import type {
  CsvPreviewIssue,
  CsvPreviewValidation,
} from "@wellregarded/sources";

import { Badge } from "~/components/ui/badge";

function IssueTable({
  issues,
  caption,
}: {
  issues: CsvPreviewIssue[];
  caption: string;
}) {
  return (
    <div className="max-h-80 overflow-auto border border-hairline">
      <table className="w-full border-collapse text-small">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-hairline">
            <th
              scope="col"
              className="sticky top-0 bg-surface-card p-2 text-left font-mono text-2xs font-medium uppercase tracking-label text-gray-500"
            >
              Row
            </th>
            <th
              scope="col"
              className="sticky top-0 bg-surface-card p-2 text-left font-mono text-2xs font-medium uppercase tracking-label text-gray-500"
            >
              Column
            </th>
            <th
              scope="col"
              className="sticky top-0 w-full bg-surface-card p-2 text-left font-mono text-2xs font-medium uppercase tracking-label text-gray-500"
            >
              What to fix
            </th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => (
            <tr
              key={`${issue.row}-${issue.column}-${issue.message}`}
              className="border-b border-hairline align-top last:border-b-0"
            >
              <td className="p-2 font-mono text-xs text-ink-900">
                {issue.row}
              </td>
              <td className="whitespace-nowrap p-2 font-mono text-xs text-ink-900">
                {issue.column}
              </td>
              <td className="p-2 text-ink-900">{issue.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface ValidationResultsProps {
  validation: CsvPreviewValidation;
}

export function ValidationResults({ validation }: ValidationResultsProps) {
  const errors = validation.issues.filter((i) => i.severity === "error");
  const warnings = validation.issues.filter((i) => i.severity === "warning");

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-body text-ink-900">
        {validation.okCount} of {validation.rowCount} sample rows look good.
        {validation.failingRowCount > 0 && (
          <>
            {" "}
            {validation.failingRowCount}{" "}
            {validation.failingRowCount === 1 ? "row" : "rows"} would be skipped
            as-is.
          </>
        )}
      </p>

      {errors.length > 0 && (
        <section aria-label="Rows that will be skipped">
          <div className="mb-2 flex items-center gap-2">
            <Badge tone="negative">will be skipped</Badge>
            <span className="text-small text-gray-600">
              Fix the file and re-upload, or adjust the mapping — these rows
              won't import otherwise.
            </span>
          </div>
          <IssueTable issues={errors} caption="Rows that will be skipped" />
        </section>
      )}

      {warnings.length > 0 && (
        <section aria-label="Rows with missing details">
          <div className="mb-2 flex items-center gap-2">
            <Badge tone="caution">imports anyway</Badge>
            <span className="text-small text-gray-600">
              These rows import fine — they're just missing an optional detail.
            </span>
          </div>
          <IssueTable issues={warnings} caption="Rows with missing details" />
        </section>
      )}

      {validation.issues.length === 0 && (
        <p className="m-0 text-small text-gray-600">
          Nothing to flag in the sample. The full file is checked the same way
          during the import, and anything unexpected lands in the import report.
        </p>
      )}
    </div>
  );
}
