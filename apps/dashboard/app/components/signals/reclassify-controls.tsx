// Manual reclassification affordances (#93) for the signal detail:
//
// - `DerivationRow` — one judged dimension with its provenance badge, the
//   one-click "was this right?" ✓/✗ on inferred judgments (✓ confirms the
//   current value in a single interaction, no dialog; ✗ opens the
//   correction picker pre-focused), and a quiet "Correct" affordance for
//   everything else.
// - `AssociationRow` — the provider/location association with
//   confirm-or-correct ("yes, this is Dr. Patel" / pick another / none).
//
// Every write is a NEW `basis: 'manual'` derivations row or an audited
// FK+hint update — append-only semantics live in `packages/db`
// (`reclassify.ts`); this file is only the affordance. Affordances the
// viewer lacks (`reclassify_signal`) are hidden, not disabled.
//
// The ✓ confirm is optimistic per the conventions doc: while the fetcher
// is in flight the badge already reads "Staff confirmed"; failure rolls
// back through the fetcher lifecycle (revalidation), no manual state.
import {
  DERIVATION_DIMENSION_VALUES,
  type DerivationBasis,
  type DerivationDimension,
} from "@wellregarded/core";
import { useState } from "react";
import { useFetcher } from "react-router";

import { Overline } from "~/components/shell/page-header";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { BasisBadge } from "./basis-badge";
import { judgmentValueLabel } from "./labels";

function isInferred(basis: DerivationBasis | null): boolean {
  return basis === "inferred_text" || basis === "inferred_related";
}

/** Mono micro-button for the ✓ / ✗ pair — one interaction, no dialog. */
function MicroButton(props: React.ComponentProps<"button">) {
  return (
    <button
      {...props}
      type={props.type ?? "button"}
      className="inline-flex h-6 w-6 cursor-pointer items-center justify-center border border-gray-300 bg-surface-card font-mono text-2xs text-gray-600 transition-colors duration-100 hover:border-accent-600 hover:text-accent-700 disabled:opacity-50"
    />
  );
}

export interface DerivationRowData {
  dimension: DerivationDimension;
  label: string;
  /** Display label ("Negative"); null = not yet classified. */
  value: string | null;
  /** Machine value ("negative"); null = not yet classified. */
  rawValue: string | null;
  basis: DerivationBasis | null;
  confidence: number | null;
  rationale: string | null;
  judgedOn: string | null;
}

export function DerivationRow({
  row,
  canReclassify,
}: {
  row: DerivationRowData;
  canReclassify: boolean;
}) {
  const fetcher = useFetcher();
  const [editing, setEditing] = useState(false);

  // Optimistic read: a submission for THIS dimension shows its outcome
  // immediately — a ✓ flips the badge to staff-confirmed, a correction
  // shows the picked value.
  const pendingIntent = fetcher.formData?.get("intent");
  const pendingForRow =
    fetcher.state !== "idle" &&
    fetcher.formData?.get("dimension") === row.dimension;
  const optimisticValue =
    pendingForRow && pendingIntent === "reclassify-derivation"
      ? String(fetcher.formData?.get("value"))
      : null;
  const displayRaw = optimisticValue ?? row.rawValue;
  const displayValue = optimisticValue
    ? judgmentValueLabel(optimisticValue)
    : row.value;
  const displayBasis: DerivationBasis | null = pendingForRow
    ? "manual"
    : row.basis;

  const options = DERIVATION_DIMENSION_VALUES[row.dimension].map((value) => ({
    value,
    label: judgmentValueLabel(value),
  }));

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
      data-testid={`derivation-row-${row.dimension}`}
    >
      <Overline className="w-44">{row.label}</Overline>
      {displayValue === null ? (
        <span className="font-mono text-data text-gray-500">
          Not yet classified
        </span>
      ) : (
        <>
          <span className="font-mono text-data font-medium text-ink-900">
            {displayValue}
          </span>
          {displayBasis !== null && (
            <BasisBadge
              basis={displayBasis}
              confidence={
                pendingForRow ? undefined : (row.confidence ?? undefined)
              }
            />
          )}
        </>
      )}

      {canReclassify && !editing && !pendingForRow && (
        <span className="inline-flex items-center gap-1.5">
          {isInferred(row.basis) && row.rawValue !== null && (
            <>
              {/* "Was this right?" — ✓ writes the confirming manual row in
                  one click; the value is re-read server-side. */}
              <fetcher.Form method="post" className="inline-flex">
                <input type="hidden" name="intent" value="confirm-derivation" />
                <input type="hidden" name="dimension" value={row.dimension} />
                <MicroButton
                  type="submit"
                  aria-label={`Confirm ${row.label.toLowerCase()}`}
                  title="Was this right? Confirm"
                >
                  ✓
                </MicroButton>
              </fetcher.Form>
              <MicroButton
                aria-label={`Correct ${row.label.toLowerCase()}`}
                title="Was this right? Correct it"
                onClick={() => setEditing(true)}
              >
                ✗
              </MicroButton>
            </>
          )}
          {!isInferred(row.basis) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditing(true)}
              aria-label={`${row.value === null ? "Classify" : "Correct"} ${row.label.toLowerCase()}`}
            >
              {row.value === null ? "Classify" : "Correct"}
            </Button>
          )}
        </span>
      )}

      {canReclassify && editing && (
        <fetcher.Form
          method="post"
          className="flex items-center gap-2"
          onSubmit={() => setEditing(false)}
        >
          <input type="hidden" name="intent" value="reclassify-derivation" />
          <input type="hidden" name="dimension" value={row.dimension} />
          <Select
            name="value"
            aria-label={`${row.label} value`}
            options={options}
            defaultValue={displayRaw ?? options[0]?.value}
            autoFocus
            className="[&_select]:py-1.5"
          />
          <Button type="submit" variant="secondary" size="sm">
            Save
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </fetcher.Form>
      )}

      {row.rationale && (
        <p className="m-0 w-full text-small text-gray-500">{row.rationale}</p>
      )}
    </div>
  );
}

export interface AssociationRowData {
  kind: "provider" | "location";
  label: string;
  /** Resolved FK's display name; null when unlinked. */
  name: string | null;
  /** The normalize-stage hint (or its manual resolution record). */
  hint: { text: string; basis: DerivationBasis } | null;
  options: Array<{ id: string; name: string }>;
}

export function AssociationRow({
  row,
  canReclassify,
}: {
  row: AssociationRowData;
  canReclassify: boolean;
}) {
  const fetcher = useFetcher();
  const [editing, setEditing] = useState(false);

  const pendingForRow =
    fetcher.state !== "idle" &&
    fetcher.formData?.get("intent") === "set-association" &&
    fetcher.formData?.get("kind") === row.kind;
  const pendingEntityId = pendingForRow
    ? String(fetcher.formData?.get("entityId"))
    : null;
  const optimisticName =
    pendingEntityId === null
      ? null
      : pendingEntityId === "none"
        ? "None"
        : (row.options.find((option) => option.id === pendingEntityId)?.name ??
          null);

  const unresolvedHint =
    row.name === null && isInferred(row.hint?.basis ?? null);
  // Pre-select the picker's best guess: an exact (case-insensitive) name
  // match for the hint text, else the current association.
  const suggestedId = unresolvedHint
    ? (row.options.find(
        (option) =>
          option.name.trim().toLowerCase() ===
          row.hint?.text.trim().toLowerCase(),
      )?.id ?? "none")
    : (row.options.find((option) => option.name === row.name)?.id ?? "none");

  const displayName = optimisticName ?? row.name;
  const manualBasis: DerivationBasis | null = pendingForRow
    ? "manual"
    : (row.hint?.basis ?? null);

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
      data-testid={`association-row-${row.kind}`}
    >
      <Overline className="w-44">{row.label}</Overline>
      {displayName !== null ? (
        <>
          <span className="font-mono text-data font-medium text-ink-900">
            {displayName}
          </span>
          {/* A resolved FK without a hint is a plain fact — no badge (the
              JudgmentChip rule). A manual hint marks staff confirmation. */}
          {manualBasis === "manual" && <BasisBadge basis="manual" />}
        </>
      ) : row.hint ? (
        <>
          <span className="font-mono text-data text-ink-800">
            “{row.hint.text}”
          </span>
          <BasisBadge
            basis={row.hint.basis}
            data-testid={`association-hint-${row.kind}`}
          />
          {row.hint.basis === "manual" && (
            <span className="font-mono text-data text-gray-500">
              No match — reviewed
            </span>
          )}
        </>
      ) : (
        <span className="font-mono text-data text-gray-500">Not linked</span>
      )}

      {canReclassify && !editing && !pendingForRow && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setEditing(true)}
          aria-label={`${unresolvedHint ? "Confirm" : "Change"} ${row.label.toLowerCase()}`}
        >
          {unresolvedHint ? "Confirm match" : "Change"}
        </Button>
      )}

      {canReclassify && editing && (
        <fetcher.Form
          method="post"
          className="flex items-center gap-2"
          onSubmit={() => setEditing(false)}
        >
          <input type="hidden" name="intent" value="set-association" />
          <input type="hidden" name="kind" value={row.kind} />
          <Select
            name="entityId"
            aria-label={`${row.label} association`}
            options={[
              { value: "none", label: "None / unknown" },
              ...row.options.map((option) => ({
                value: option.id,
                label: option.name,
              })),
            ]}
            defaultValue={suggestedId}
            autoFocus
            className="[&_select]:py-1.5"
          />
          <Button type="submit" variant="secondary" size="sm">
            Save
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </fetcher.Form>
      )}
    </div>
  );
}
