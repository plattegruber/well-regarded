// ConsentPanel (#90): read-only display of the recorded consent state,
// computed once by `describeConsentState` in @wellregarded/core (the one
// interpretation of "is this publishable" — proof surfaces reuse it).
// Publishability is stated strictly in terms of recorded consent; when no
// rows exist the panel says exactly so — never a default-open state.
// Consent *capture* flows are Epic #12; nothing here mutates.
import type { ConsentStateStatus } from "@wellregarded/core";
import { Overline } from "~/components/shell/page-header";
import { Card } from "~/components/ui/card";
import { cn } from "~/lib/utils";

/** Consent color-coding from the mockup: granted green, refused red,
 * nothing-recorded quiet gray. Shared by the panel and the inbox rows. */
export function consentToneClass(status: ConsentStateStatus): string {
  switch (status) {
    case "granted":
      return "text-accent-700";
    case "revoked":
    case "expired":
      return "text-red-700";
    case "none":
      return "text-gray-500";
  }
}

export interface ConsentPanelDetails {
  /** Channel display labels, e.g. ["Website", "In office"]. */
  channels: string[];
  attribution: string;
  source: string;
  grantedOn: string;
  expiresOn: string | null;
  revokedOn: string | null;
  version: number;
  allowMinorEdits: boolean;
}

export interface ConsentPanelData {
  publishable: boolean;
  status: ConsentStateStatus;
  summary: string;
  details: ConsentPanelDetails | null;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <Overline>{label}</Overline>
      <span className="text-right font-mono text-data text-ink-800">
        {value}
      </span>
    </div>
  );
}

export function ConsentPanel({ consent }: { consent: ConsentPanelData }) {
  const { details } = consent;
  return (
    <Card title="Consent" data-testid="consent-panel">
      <p
        className={cn(
          "m-0 font-mono text-data font-medium",
          consentToneClass(consent.status),
        )}
      >
        {consent.summary}
      </p>
      {details && (
        <div className="mt-3.5 flex flex-col gap-2 border-t border-hairline pt-3.5">
          <Row label="Channels" value={details.channels.join(", ") || "None"} />
          <Row label="Attribution" value={details.attribution} />
          <Row label="Source" value={details.source} />
          <Row label="Granted" value={details.grantedOn} />
          {details.expiresOn && (
            <Row label="Expires" value={details.expiresOn} />
          )}
          {details.revokedOn && (
            <Row label="Revoked" value={details.revokedOn} />
          )}
          <Row
            label="Minor edits"
            value={details.allowMinorEdits ? "Allowed" : "Not allowed"}
          />
          <Row label="Version" value={`v${details.version}`} />
        </div>
      )}
      <p className="mt-3.5 mb-0 text-small text-gray-500">
        Publication is only ever computed from recorded consent — there is no
        override.
      </p>
    </Card>
  );
}
