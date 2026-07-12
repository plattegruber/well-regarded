// Display vocabulary for the signals surfaces (#88/#90) — sentence-case
// labels per the voice rules, shared by the list rows, the detail view,
// and their tests. Formatting is done server-side in loaders so route
// components stay presentational.
import type {
  ConsentAttribution,
  ConsentSource,
  DerivationBasis,
  DerivationDimension,
  SourceKind,
} from "@wellregarded/core";

/** Where a signal came from, as the mockup names them. */
export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  google: "Google",
  csv_import: "CSV import",
  manual: "Manual entry",
  email: "Email",
  firstparty: "Post-visit",
  opendental: "OpenDental",
};

/** Detail-page titles: what kind of thing the reader is looking at. */
export const SOURCE_KIND_TITLES: Record<SourceKind, string> = {
  google: "Google review",
  csv_import: "Imported feedback",
  manual: "Staff note",
  email: "Email feedback",
  firstparty: "Post-visit response",
  opendental: "OpenDental record",
};

export const DIMENSION_LABELS: Record<DerivationDimension, string> = {
  sentiment: "Sentiment",
  urgency: "Urgency",
  response_risk: "Response risk",
  publication_suitability: "Publication suitability",
};

/** How a judgment was reached — plain language for the basis badge. */
export const BASIS_LABELS: Record<DerivationBasis, string> = {
  manual: "Staff confirmed",
  source_metadata: "From source data",
  inferred_text: "Inferred from text",
  inferred_related: "Inferred from related signals",
};

export const ATTRIBUTION_LABELS: Record<ConsentAttribution, string> = {
  full_name: "Full name",
  first_name: "First name",
  initials: "Initials",
  anonymous: "Anonymous",
};

export const CONSENT_SOURCE_LABELS: Record<ConsentSource, string> = {
  patient_link: "Patient link",
  practice_attested: "Practice attested",
  imported_unknown: "Imported — origin unknown",
};

/** Plain-language confidence, per the "no naked percentages" instinct. */
export function confidenceLabel(confidence: number): string {
  if (confidence >= 0.9) return "high confidence";
  if (confidence >= 0.7) return "moderate confidence";
  return "low confidence";
}

/** A judgment value ("response_risk" → "Response risk") in sentence case. */
export function judgmentValueLabel(value: string): string {
  const text = value.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Quiet relative age for list rows: "today", "3d ago", "2mo ago". */
export function formatAge(date: Date, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - date.getTime()) / DAY_MS);
  if (days <= 0) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Full date for the detail view: "July 4, 2026". Rendered in UTC until
 * practices carry a wired timezone (same note as todayOverline). */
export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
