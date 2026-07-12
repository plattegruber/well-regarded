// The wizard's persistent stepper (#134): four steps, always visible, the
// current one marked with aria-current="step". Steps already reached are
// links (the draft persists each step, so walking back is safe); future
// steps are inert text — skipping ahead would outrun the saved state.
import { IMPORT_WIZARD_STEPS, type ImportWizardStep } from "@wellregarded/core";
import { Link } from "react-router";

import { cn } from "~/lib/utils";

const STEP_LABELS: Record<ImportWizardStep, string> = {
  map: "Map columns",
  validate: "Check rows",
  consent: "Consent",
  confirm: "Confirm",
};

export interface WizardStepperProps {
  draftId: string;
  current: ImportWizardStep;
  /** The furthest step the draft has reached — everything up to it links. */
  reached: ImportWizardStep;
}

export function WizardStepper({
  draftId,
  current,
  reached,
}: WizardStepperProps) {
  const reachedIndex = IMPORT_WIZARD_STEPS.indexOf(reached);

  return (
    <nav aria-label="Import steps" className="mb-6">
      <ol className="m-0 flex list-none flex-wrap items-center gap-x-2 gap-y-1 p-0">
        {IMPORT_WIZARD_STEPS.map((step, index) => {
          const isCurrent = step === current;
          const linkable = index <= reachedIndex && !isCurrent;
          const label = (
            <>
              <span className="font-mono text-2xs">{index + 1}</span>
              {STEP_LABELS[step]}
            </>
          );
          const baseClass = cn(
            "inline-flex items-center gap-1.5 border px-2.5 py-1.5 font-mono text-xs font-medium uppercase tracking-label",
            isCurrent
              ? "border-ink-900 bg-ink-900 text-on-dark"
              : index <= reachedIndex
                ? "border-outline-strong text-ink-900"
                : "border-hairline text-gray-400",
          );
          return (
            <li key={step} className="flex items-center gap-2">
              {index > 0 && (
                <span aria-hidden="true" className="text-gray-300">
                  —
                </span>
              )}
              {linkable ? (
                <Link
                  to={`/settings/imports/${draftId}/${step}`}
                  className={cn(baseClass, "no-underline hover:bg-gray-50")}
                >
                  {label}
                </Link>
              ) : (
                <span
                  aria-current={isCurrent ? "step" : undefined}
                  className={baseClass}
                >
                  {label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
