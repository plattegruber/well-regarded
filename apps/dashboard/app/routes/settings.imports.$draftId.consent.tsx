// Wizard step 3 — consent (#134). Applies when the file carries private
// feedback or patient PII (consentRequiredForMapping, @wellregarded/core);
// otherwise the step explains itself and passes through. The action never
// trusts the client's idea of whether consent was required: it recomputes
// from the SAVED mapping, so skipping is only possible when the server
// agrees there is nothing to consent to.
import {
  can,
  consentRequiredForMapping,
  IMPORT_CONSENT_HINTS,
  type ImportConsentHint,
  mappingConsentChoice,
} from "@wellregarded/core";
import {
  getImportDraft,
  saveImportDraftConsent,
  setImportDraftWizardStep,
} from "@wellregarded/db";
import { data, Form, Link, redirect, useRouteLoaderData } from "react-router";

import { SubmitButton } from "~/components/form/submit-button";
import { ConsentForm } from "~/components/imports/consent-form";
import { Card } from "~/components/ui/card";
import { withRequestDb } from "~/lib/db.server";
import type { FieldErrors } from "~/lib/forms.server";
import { requireDraftIdParam } from "~/lib/import-wizard.server";
import { requirePracticeContext } from "~/lib/practice-context.server";
import type { Route } from "./+types/settings.imports.$draftId.consent";
import type { loader as wizardLoader } from "./settings.imports.$draftId";

export function meta() {
  return [{ title: "Consent · Well Regarded" }];
}

function isConsentHint(value: string): value is ImportConsentHint {
  return (IMPORT_CONSENT_HINTS as readonly string[]).includes(value);
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const draftId = requireDraftIdParam(params.draftId);
  const formData = await request.formData();

  return withRequestDb(context, async (db) => {
    // 1. Permission check — in the action, always.
    const ctx = await requirePracticeContext(db);
    if (!can(ctx.actor, "manage_settings", { practiceId: ctx.practiceId })) {
      throw data(null, { status: 403 });
    }

    const draft = await getImportDraft(db, ctx.practiceId, draftId);
    if (!draft) throw data(null, { status: 404 });
    if (draft.mapping === null) {
      // Consent attaches to a mapping; without one, back to step 1.
      throw redirect(`/settings/imports/${draftId}/map`);
    }

    // Nothing private, nothing identifying — the step is informational
    // and continuing just moves the bookmark.
    if (!consentRequiredForMapping(draft.mapping)) {
      await setImportDraftWizardStep(db, {
        practiceId: ctx.practiceId,
        draftId,
        step: "confirm",
      });
      return redirect(`/settings/imports/${draftId}/confirm`);
    }

    // 2. Parse. No default: an absent choice is a field error, never a
    //    silent imported_unknown.
    const fieldErrors: FieldErrors = {};
    const rawChoice = formData.get("consentChoice");
    const choice = typeof rawChoice === "string" ? rawChoice : "";
    if (!isConsentHint(choice)) {
      fieldErrors.consentChoice = [
        "Choose one — this decides whether any of these can ever be published.",
      ];
    }
    const rawNote = formData.get("attestationNote");
    const note = typeof rawNote === "string" ? rawNote.trim() : "";
    if (choice === "practice_attested" && note === "") {
      fieldErrors.attestationNote = [
        "Note where the permission lives (for example, signed intake forms) — future you will want it.",
      ];
    }
    if (Object.keys(fieldErrors).length > 0 || !isConsentHint(choice)) {
      return data({ fieldErrors }, { status: 422 });
    }

    // 3. Mutate + audit (one transaction inside the helper).
    const result = await saveImportDraftConsent(db, {
      practiceId: ctx.practiceId,
      actor: ctx.auditActor,
      draftId,
      consentChoice: choice,
      attestationNote: choice === "practice_attested" ? note : null,
    });

    switch (result.outcome) {
      case "not_found":
        throw data(null, { status: 404 });
      case "mapping_missing":
        throw redirect(`/settings/imports/${draftId}/map`);
      case "not_editable":
        throw redirect(`/settings/imports/${draftId}`);
      case "ok":
        // 4 + 5. On to the summary.
        return redirect(`/settings/imports/${draftId}/confirm`);
    }
  });
}

export default function ConsentStep({ actionData }: Route.ComponentProps) {
  const wizard = useRouteLoaderData<typeof wizardLoader>(
    "routes/settings.imports.$draftId",
  );
  if (!wizard) return null;

  if (wizard.draft.mapping === null) {
    return (
      <Card title="Map the columns first" sunken className="max-w-130">
        <p className="m-0 text-small text-gray-600">
          The consent question depends on what you map — start with{" "}
          <Link
            to={`/settings/imports/${wizard.draft.id}/map`}
            className="text-ink-900 underline"
          >
            the mapping step
          </Link>
          .
        </p>
      </Card>
    );
  }

  if (wizard.consentRequired === false) {
    return (
      <div className="flex max-w-130 flex-col gap-4">
        <Card title="No consent step needed" sunken>
          <p className="m-0 text-small text-gray-600">
            Nothing in this file is private feedback or personally identifying,
            so there's no consent decision to make. If that doesn't sound right,
            adjust the mapping.
          </p>
        </Card>
        <Form method="post">
          <SubmitButton pendingLabel="Continuing…">Continue</SubmitButton>
        </Form>
      </div>
    );
  }

  return (
    <ConsentForm
      defaultChoice={mappingConsentChoice(wizard.draft.mapping)}
      defaultNote={wizard.draft.attestationNote}
      fieldErrors={actionData?.fieldErrors}
    />
  );
}
