// Column-mapping wizard layout (#134): the persistent frame — page header
// and stepper — around the four step routes. One loader feeds every step
// (draft + preview + detection + validation, via loadWizardData), so
// walking between steps is one DB read + one ranged R2 read per
// navigation, and the steps themselves stay presentational.
//
// TODO(#59): auth flows through requirePracticeContext (the demo-practice
// seam) until Epic #4 wires Clerk.
import type { ImportWizardStep } from "@wellregarded/core";
import { Link, Outlet, useLocation } from "react-router";

import { WizardStepper } from "~/components/imports/stepper";
import { PageHeader } from "~/components/shell/page-header";
import { loadWizardData, type WizardData } from "~/lib/import-wizard.server";
import type { Route } from "./+types/settings.imports.$draftId";

export function meta({ data }: Route.MetaArgs) {
  return [
    {
      title: `Import ${data?.draft.originalFilename ?? "CSV"} · Well Regarded`,
    },
  ];
}

/** Human-scale byte size, honest and plain ("2.4 MB", "980 KB"). */
export function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export async function loader({
  params,
  context,
}: Route.LoaderArgs): Promise<WizardData> {
  const { ctx: _ctx, ...data } = await loadWizardData(context, params.draftId);
  return data;
}

const STEP_SEGMENTS: ReadonlyArray<ImportWizardStep> = [
  "map",
  "validate",
  "consent",
  "confirm",
];

function stepFromPathname(pathname: string): ImportWizardStep {
  const last = pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  return (STEP_SEGMENTS as readonly string[]).includes(last)
    ? (last as ImportWizardStep)
    : "map";
}

export default function ImportWizardLayout({
  loaderData,
}: Route.ComponentProps) {
  const { draft, previewRows } = loaderData;
  const current = stepFromPathname(useLocation().pathname);
  // The furthest step reached: the saved bookmark, or wherever the URL
  // already is (a fresh draft opening /map has reached "map").
  const reached =
    (STEP_SEGMENTS as readonly string[]).indexOf(draft.wizardStep ?? "map") >=
    (STEP_SEGMENTS as readonly string[]).indexOf(current)
      ? (draft.wizardStep ?? "map")
      : current;

  return (
    <>
      <PageHeader
        overline="Settings · imports"
        title="Import a CSV"
        description={
          <>
            <span className="font-mono">{draft.originalFilename}</span> ·{" "}
            {formatByteSize(draft.byteSize)} · previewing {previewRows.length}{" "}
            rows. Your progress saves at each step.
          </>
        }
      />
      <WizardStepper draftId={draft.id} current={current} reached={reached} />
      <Outlet />
      <p className="m-0 mt-6 text-small text-gray-500">
        <Link to="/settings/imports" className="text-ink-900 underline">
          Back to imports
        </Link>
      </p>
    </>
  );
}
