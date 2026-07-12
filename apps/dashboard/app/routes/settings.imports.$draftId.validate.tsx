// Wizard step 2 — validation preview (#134). The results were computed in
// the layout loader with `validateCsvPreviewRows` (@wellregarded/sources)
// — a reshaping of `validateCsvRow`, the EXACT validator the import
// Workflow (#135) runs over the full file, so this preview cannot drift
// from what the import will do. Continuing
// just moves the resume bookmark; rows that fail here are skipped (and
// reported) by the Workflow, so they warn rather than block.
import { can } from "@wellregarded/core";
import { setImportDraftWizardStep } from "@wellregarded/db";
import { data, Form, Link, redirect, useRouteLoaderData } from "react-router";

import { SubmitButton } from "~/components/form/submit-button";
import { ValidationResults } from "~/components/imports/validation-results";
import { buttonVariants } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { withRequestDb } from "~/lib/db.server";
import { requireDraftIdParam } from "~/lib/import-wizard.server";
import { requirePracticeContext } from "~/lib/practice-context.server";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/settings.imports.$draftId.validate";
import type { loader as wizardLoader } from "./settings.imports.$draftId";

export function meta() {
  return [{ title: "Check rows · Well Regarded" }];
}

export async function action({ params, context }: Route.ActionArgs) {
  const draftId = requireDraftIdParam(params.draftId);
  return withRequestDb(context, async (db) => {
    const ctx = await requirePracticeContext(db);
    if (!can(ctx.actor, "manage_settings", { practiceId: ctx.practiceId })) {
      throw data(null, { status: 403 });
    }
    const updated = await setImportDraftWizardStep(db, {
      practiceId: ctx.practiceId,
      draftId,
      step: "consent",
    });
    if (!updated) throw data(null, { status: 404 });
    return redirect(`/settings/imports/${draftId}/consent`);
  });
}

export default function ValidateStep(_props: Route.ComponentProps) {
  const wizard = useRouteLoaderData<typeof wizardLoader>(
    "routes/settings.imports.$draftId",
  );
  if (!wizard) return null;

  if (wizard.validation === null) {
    return (
      <Card title="Map the columns first" sunken className="max-w-130">
        <p className="m-0 mb-3.5 text-small text-gray-600">
          The rows can't be checked until each column has a field. It takes a
          minute — most of it is already suggested.
        </p>
        <Link
          to={`/settings/imports/${wizard.draft.id}/map`}
          className={cn(
            buttonVariants({ variant: "secondary", size: "md" }),
            "no-underline",
          )}
        >
          Go to mapping
        </Link>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <ValidationResults validation={wizard.validation} />
      <p className="m-0 text-small text-gray-600">
        This checks the {wizard.validation.rowCount} preview rows. The full file
        is checked the same way during the import; skipped rows are listed in
        the import report.
      </p>
      <Form method="post" className="flex items-center gap-3">
        <SubmitButton pendingLabel="Continuing…">Continue</SubmitButton>
        <Link
          to={`/settings/imports/${wizard.draft.id}/map`}
          className={cn(
            buttonVariants({ variant: "ghost", size: "md" }),
            "no-underline",
          )}
        >
          Adjust the mapping
        </Link>
      </Form>
    </div>
  );
}
