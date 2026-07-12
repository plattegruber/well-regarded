// BasisBadge — THE shared provenance marker for derived facts (issues
// #67/#88/#90, ethical invariant #1): an AI inference is never presented
// as confirmed fact. Every rendered judgment carries how we know it
// (basis) and, on the detail surfaces, how sure the model was — in plain
// language, not naked percentages.
//
// Two renderings, one vocabulary:
// - `BasisBadge` — the detail panels' full form: "Inferred from text ·
//   moderate confidence". Dashed outline for inferred bases; solid for
//   staff-confirmed and source-metadata facts.
// - `JudgmentChip` — the inbox rows' compact form, straight from the
//   mockup: a dashed mono chip whose label gains "· inferred" when a
//   model guessed it.
//
// Epic #10's review surfaces import from here too — do not fork.
import type { DerivationBasis } from "@wellregarded/core";

import { cn } from "~/lib/utils";
import { BASIS_LABELS, confidenceLabel } from "./labels";

function isInferred(basis: DerivationBasis): boolean {
  return basis === "inferred_text" || basis === "inferred_related";
}

export interface BasisBadgeProps extends React.ComponentProps<"span"> {
  basis: DerivationBasis;
  /** 0–1; rendered as plain language. Omit to show the basis alone. */
  confidence?: number;
}

export function BasisBadge({
  basis,
  confidence,
  className,
  ...props
}: BasisBadgeProps) {
  const inferred = isInferred(basis);
  return (
    <span
      data-testid="basis-badge"
      data-basis={basis}
      className={cn(
        "inline-flex items-center whitespace-nowrap border px-2 py-1.25",
        "font-mono text-2xs font-medium",
        inferred
          ? "border-dashed border-gray-300 bg-surface-card text-gray-600"
          : "border-solid border-gray-300 bg-gray-50 text-ink-800",
        className,
      )}
      {...props}
    >
      {BASIS_LABELS[basis]}
      {confidence !== undefined && ` · ${confidenceLabel(confidence)}`}
    </span>
  );
}

export interface JudgmentChipProps extends React.ComponentProps<"span"> {
  label: string;
  /** Omit for facts that are not judgments (a resolved location FK). */
  basis?: DerivationBasis;
}

/** The mockup's dashed mono chip; "· inferred" marks model guesses. */
export function JudgmentChip({
  label,
  basis,
  className,
  ...props
}: JudgmentChipProps) {
  const inferred = basis !== undefined && isInferred(basis);
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap border border-dashed px-2 py-1.25",
        "font-mono text-label font-medium leading-none",
        inferred
          ? "border-gray-300 bg-surface-card text-gray-600"
          : "border-gray-200 bg-gray-50 text-ink-800",
        className,
      )}
      {...props}
    >
      {label}
      {inferred && " · inferred"}
    </span>
  );
}
