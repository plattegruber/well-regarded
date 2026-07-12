// Step 1 of the mapping wizard (#134): the preview table with one mapping
// combobox per column, prefilled from the header-name heuristics in
// @wellregarded/core. The two design rules this file exists to enforce:
//
// 1. Suggestions are honest. A prefilled column shows a "suggested" tag
//    until the human touches it (or confirms the lot via "These look
//    right") — a wrong suggestion silently accepted is the failure mode.
// 2. Ambiguity is never resolved silently. An ambiguous date detection
//    renders the candidate formats as radios with real sample rows read
//    both ways, and NO default — continuing without choosing is a field
//    error, client and server.
import {
  type ColumnDetection,
  type ColumnMapping,
  type DateFormatDetection,
  IMPORT_DATE_FORMATS,
  IMPORT_TARGET_FIELDS,
  type ImportDateFormat,
  type ImportTargetField,
  isSourceInfoHeader,
  parseImportDate,
  RATING_SCALES,
} from "@wellregarded/core";
import { useMemo, useState } from "react";
import { Form } from "react-router";

import { SubmitButton } from "~/components/form/submit-button";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Combobox, type ComboboxOption } from "~/components/ui/combobox";
import type { FieldErrors } from "~/lib/forms.server";
import { DONT_IMPORT, TARGET_FIELD_LABELS } from "~/lib/import-mapping-form";
import { cn } from "~/lib/utils";

const RATING_SCALE_LABELS: Record<number, string> = {
  5: "Out of 5 (stars)",
  10: "Out of 10",
  100: "Out of 100",
};

/** "January 2, 2024" — how a sample date reads under a candidate format. */
function readSample(value: string, format: ImportDateFormat): string | null {
  const date = parseImportDate(value, format);
  if (date === null) return null;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function columnSamples(
  previewRows: readonly (readonly string[])[],
  index: number,
  count: number,
): string[] {
  const samples: string[] = [];
  for (const row of previewRows) {
    const value = (row[index] ?? "").trim();
    if (value !== "") samples.push(value);
    if (samples.length === count) break;
  }
  return samples;
}

interface InitialColumnState {
  target: ImportTargetField | typeof DONT_IMPORT;
  dateFormat: string;
  ratingScale: string;
  /** True when the prefill came from detection, not a saved mapping. */
  fromSuggestion: boolean;
}

/**
 * Prefill order: the saved mapping wins (resuming a draft must show what
 * was saved), then detection suggestions, then "Don't import". Source-info
 * columns (source/platform/channel) stay unmapped — M1 imports are one
 * source per file.
 */
function initialColumns(
  headers: readonly string[],
  detected: readonly ColumnDetection[],
  savedMapping: ColumnMapping | null,
): InitialColumnState[] {
  const savedByColumn = new Map<
    string,
    { target: ImportTargetField; dateFormat?: string; ratingScale?: number }
  >();
  if (savedMapping) {
    for (const target of IMPORT_TARGET_FIELDS) {
      const entry = savedMapping[target];
      if (entry !== undefined && "column" in entry) {
        savedByColumn.set(entry.column, {
          target,
          ...("dateFormat" in entry ? { dateFormat: entry.dateFormat } : {}),
          ...("ratingScale" in entry ? { ratingScale: entry.ratingScale } : {}),
        });
      }
    }
  }

  return headers.map((header, i) => {
    const saved = savedByColumn.get(header);
    if (saved) {
      return {
        target: saved.target,
        dateFormat: saved.dateFormat ?? "",
        ratingScale: saved.ratingScale ? String(saved.ratingScale) : "",
        fromSuggestion: false,
      };
    }
    // With a saved mapping present, unsaved columns were deliberately left
    // out — do not resurrect suggestions for them.
    if (savedMapping) {
      return {
        target: DONT_IMPORT,
        dateFormat: "",
        ratingScale: "",
        fromSuggestion: false,
      };
    }
    const detection = detected[i];
    const suggested =
      detection?.suggestedTarget ?? (null as ImportTargetField | null);
    if (suggested === null || isSourceInfoHeader(header)) {
      return {
        target: DONT_IMPORT,
        dateFormat: "",
        ratingScale: "",
        fromSuggestion: false,
      };
    }
    const dateDetection = detection?.dateFormat;
    return {
      target: suggested,
      // An ambiguous detection prefills NOTHING — the human must choose.
      dateFormat:
        dateDetection && "format" in dateDetection ? dateDetection.format : "",
      ratingScale: detection?.ratingScale ? String(detection.ratingScale) : "",
      fromSuggestion: true,
    };
  });
}

export interface MappingFormProps {
  headers: string[];
  previewRows: string[][];
  detected: ColumnDetection[];
  savedMapping: ColumnMapping | null;
  fieldErrors?: FieldErrors;
}

export function MappingForm({
  headers,
  previewRows,
  detected,
  savedMapping,
  fieldErrors,
}: MappingFormProps) {
  const initial = useMemo(
    () => initialColumns(headers, detected, savedMapping),
    [headers, detected, savedMapping],
  );
  const [columns, setColumns] = useState(initial);
  const [touched, setTouched] = useState<ReadonlySet<number>>(new Set());
  const [confirmedAll, setConfirmedAll] = useState(false);

  const setColumn = (i: number, patch: Partial<InitialColumnState>) => {
    setColumns((prev) =>
      prev.map((col, j) => (j === i ? { ...col, ...patch } : col)),
    );
  };
  const touch = (i: number) => setTouched((prev) => new Set(prev).add(i));

  const suggestionPending = (i: number) =>
    initial[i]?.fromSuggestion === true &&
    columns[i]?.target !== DONT_IMPORT &&
    !touched.has(i) &&
    !confirmedAll;

  const pendingCount = headers.reduce(
    (n, _h, i) => n + (suggestionPending(i) ? 1 : 0),
    0,
  );

  const visibilityColumnMapped = columns.some(
    (col) => col.target === "visibility",
  );
  const savedVisibilityConstant =
    savedMapping?.visibility !== undefined &&
    "constant" in savedMapping.visibility
      ? savedMapping.visibility.constant
      : null;

  const formError = fieldErrors?.[""]?.[0];

  return (
    <Form method="post" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-small text-gray-600">
          Match each column to a Well Regarded field. Suggested matches are
          tagged — check them before continuing, or leave a column on "Don't
          import" to skip it.
        </p>
        {pendingCount > 0 && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setConfirmedAll(true)}
          >
            These look right
          </Button>
        )}
      </div>

      {pendingCount > 0 && (
        <p className="m-0 font-mono text-2xs uppercase tracking-label text-status-caution">
          {pendingCount} suggested{" "}
          {pendingCount === 1 ? "match hasn't" : "matches haven't"} been checked
          yet
        </p>
      )}

      {formError && (
        <p role="alert" className="m-0 text-small text-danger">
          {formError}
        </p>
      )}

      <div className="max-h-100 overflow-auto border border-hairline">
        <table className="w-full border-collapse text-small">
          <thead>
            <tr>
              <th className="sticky top-0 z-10 border-b border-hairline bg-surface-card p-2 align-top">
                <span className="font-mono text-2xs uppercase tracking-label text-gray-500">
                  Row
                </span>
              </th>
              {headers.map((header, i) => {
                const col = columns[i];
                if (!col) return null;
                const detection = detected[i];
                const sourceInfo = isSourceInfoHeader(header);
                const columnError =
                  fieldErrors?.[`column-${i}`]?.[0] ??
                  fieldErrors?.[`ratingScale-${i}`]?.[0];
                const options: ComboboxOption[] = [
                  { value: DONT_IMPORT, label: "Don't import" },
                  ...IMPORT_TARGET_FIELDS.map((target) => ({
                    value: target,
                    label: TARGET_FIELD_LABELS[target],
                    ...(detection?.suggestedTarget === target
                      ? { hint: "suggested" }
                      : {}),
                  })),
                ];
                return (
                  <th
                    key={header === "" ? `col-${i}` : header}
                    scope="col"
                    className="sticky top-0 z-10 min-w-52 border-b border-hairline bg-surface-card p-2 text-left align-top font-normal"
                  >
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-ink-900">
                        {header === "" ? `Column ${i + 1}` : header}
                      </span>
                      {sourceInfo && (
                        <Badge tone="neutral">source — one per file</Badge>
                      )}
                      {suggestionPending(i) && (
                        <Badge tone="caution">suggested</Badge>
                      )}
                    </div>
                    <Combobox
                      name={`column-${i}`}
                      ariaLabel={`Field for column ${header === "" ? i + 1 : header}`}
                      options={options}
                      value={col.target}
                      onChange={(value) => {
                        touch(i);
                        setColumn(i, {
                          target: value as ImportTargetField | "",
                        });
                      }}
                      inputClassName={cn(
                        suggestionPending(i) &&
                          "border-dashed border-status-caution",
                      )}
                    />
                    {columnError && (
                      <p role="alert" className="m-0 mt-1 text-xs text-danger">
                        {columnError}
                      </p>
                    )}
                    {col.target === "occurredAt" && (
                      <DateFormatChooser
                        index={i}
                        detection={detection?.dateFormat}
                        value={col.dateFormat}
                        samples={columnSamples(previewRows, i, 2)}
                        error={fieldErrors?.[`dateFormat-${i}`]?.[0]}
                        onChange={(format) => {
                          touch(i);
                          setColumn(i, { dateFormat: format });
                        }}
                      />
                    )}
                    {col.target === "rating" && (
                      <label className="mt-2 block">
                        <span className="mb-1 block font-mono text-2xs uppercase tracking-label text-gray-500">
                          Rating scale
                        </span>
                        <select
                          name={`ratingScale-${i}`}
                          value={col.ratingScale}
                          onChange={(event) => {
                            touch(i);
                            setColumn(i, { ratingScale: event.target.value });
                          }}
                          className="w-full border border-outline-strong bg-surface-card px-2 py-1.5 text-small text-ink-900 focus:shadow-focus-ring focus:outline-none"
                        >
                          <option value="">Choose a scale…</option>
                          {RATING_SCALES.map((scale) => (
                            <option key={scale} value={scale}>
                              {RATING_SCALE_LABELS[scale]}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {previewRows.map((row, rowIndex) => (
              <tr
                // biome-ignore lint/suspicious/noArrayIndexKey: preview rows are static per draft — position is identity
                key={rowIndex}
                className="border-b border-hairline last:border-b-0 hover:bg-gray-50"
              >
                <td className="p-2 font-mono text-2xs text-gray-400">
                  {rowIndex + 1}
                </td>
                {headers.map((_header, colIndex) => (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional by construction — preview rows never reorder
                    key={colIndex}
                    className="max-w-64 truncate p-2 text-ink-900"
                    title={row[colIndex] ?? ""}
                  >
                    {row[colIndex] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="m-0 font-mono text-2xs uppercase tracking-label text-gray-500">
        Showing the first {previewRows.length} rows
      </p>

      {!visibilityColumnMapped && (
        <fieldset className="m-0 border border-hairline p-4">
          <legend className="px-1 font-mono text-label font-medium uppercase tracking-label text-gray-600">
            What is this file?
          </legend>
          <div className="flex flex-col gap-2.5">
            <label className="flex items-baseline gap-2.5 text-small text-ink-900">
              <input
                type="radio"
                name="visibility"
                value="public"
                defaultChecked={savedVisibilityConstant === "public"}
              />
              <span>
                Public reviews — these were already published somewhere (for
                example, a review site).
              </span>
            </label>
            <label className="flex items-baseline gap-2.5 text-small text-ink-900">
              <input
                type="radio"
                name="visibility"
                value="private"
                defaultChecked={savedVisibilityConstant === "private"}
              />
              <span>
                Private feedback — patients shared these with the practice, not
                the public.
              </span>
            </label>
          </div>
          {fieldErrors?.visibility?.[0] && (
            <p role="alert" className="m-0 mt-2 text-small text-danger">
              {fieldErrors.visibility[0]}
            </p>
          )}
        </fieldset>
      )}

      <div className="flex items-center gap-3">
        <SubmitButton pendingLabel="Saving…">Continue</SubmitButton>
      </div>
    </Form>
  );
}

interface DateFormatChooserProps {
  index: number;
  detection: DateFormatDetection | undefined;
  value: string;
  samples: string[];
  error?: string;
  onChange: (format: string) => void;
}

/**
 * The date-format control. Ambiguous detection → radios over ONLY the
 * surviving candidates, each showing how the sample rows would read, no
 * default. Otherwise → a select over every supported format, prefilled
 * when detection was certain.
 */
function DateFormatChooser({
  index,
  detection,
  value,
  samples,
  error,
  onChange,
}: DateFormatChooserProps) {
  const ambiguous =
    detection && "ambiguous" in detection ? detection.ambiguous : null;

  if (ambiguous) {
    return (
      <fieldset className="mt-2 border border-status-caution p-2">
        <legend className="px-1 font-mono text-2xs uppercase tracking-label text-status-caution">
          Which way do these dates read?
        </legend>
        <div className="flex flex-col gap-2">
          {ambiguous.map((format) => (
            <label
              key={format}
              className="flex items-baseline gap-2 text-xs text-ink-900"
            >
              <input
                type="radio"
                name={`dateFormat-${index}`}
                value={format}
                checked={value === format}
                onChange={() => onChange(format)}
              />
              <span>
                <span className="font-mono font-semibold">{format}</span>
                {samples.map((sample) => {
                  const read = readSample(sample, format);
                  return read === null ? null : (
                    <span key={sample} className="block text-gray-600">
                      {sample} → {read}
                    </span>
                  );
                })}
              </span>
            </label>
          ))}
        </div>
        {error && (
          <p role="alert" className="m-0 mt-1.5 text-xs text-danger">
            {error}
          </p>
        )}
      </fieldset>
    );
  }

  return (
    <label className="mt-2 block">
      <span className="mb-1 block font-mono text-2xs uppercase tracking-label text-gray-500">
        Date format
      </span>
      <select
        name={`dateFormat-${index}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full border border-outline-strong bg-surface-card px-2 py-1.5 text-small text-ink-900 focus:shadow-focus-ring focus:outline-none"
      >
        <option value="">Choose a format…</option>
        {IMPORT_DATE_FORMATS.map((format) => (
          <option key={format} value={format}>
            {format}
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" className="m-0 mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </label>
  );
}
