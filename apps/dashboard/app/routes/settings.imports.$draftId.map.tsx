// Wizard step 1 — preview & mapping (#134). The component is thin: data
// comes from the layout loader, the heavy UI lives in MappingForm, and
// the action follows the five-step recipe (permission → parse → mutate +
// audit → redirect), with `parseMappingForm` doing the dynamic-form
// parsing the static `parseForm` helper can't.
import { can } from "@wellregarded/core";
import { getImportDraft, saveImportDraftMapping } from "@wellregarded/db";
import { data, redirect, useRouteLoaderData } from "react-router";

import { MappingForm } from "~/components/imports/mapping-form";
import { withRequestDb } from "~/lib/db.server";
import { setFlash } from "~/lib/flash.server";
import { parseMappingForm } from "~/lib/import-mapping-form";
import { requireDraftIdParam } from "~/lib/import-wizard.server";
import { requirePracticeContext } from "~/lib/practice-context.server";
import type { Route } from "./+types/settings.imports.$draftId.map";
import type { loader as wizardLoader } from "./settings.imports.$draftId";

export function meta() {
  return [{ title: "Map columns · Well Regarded" }];
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

    // 2. Parse — user mistakes come back as 422 fieldErrors, never thrown.
    const parsed = parseMappingForm(formData, draft.headers);
    if (!parsed.ok) {
      return data({ fieldErrors: parsed.fieldErrors }, { status: 422 });
    }

    // 3. Mutate + audit (one transaction inside the helper — the same
    //    code path the API worker's PUT uses).
    const result = await saveImportDraftMapping(db, {
      practiceId: ctx.practiceId,
      actor: ctx.auditActor,
      draftId,
      mapping: parsed.mapping,
      wizardStep: "validate",
    });

    switch (result.outcome) {
      case "not_found":
        throw data(null, { status: 404 });
      case "not_editable":
        // Someone confirmed it meanwhile; the layout loader explains.
        throw redirect(`/settings/imports/${draftId}`);
      case "unknown_columns":
        // The form was built FROM the stored headers, so this is a stale
        // tab, not a user mistake worth per-field blame.
        return data(
          {
            fieldErrors: {
              "": [
                "This file's columns changed since the page loaded. Refresh and try again.",
              ],
            },
          },
          { status: 422 },
        );
      case "ok":
        // 4 + 5. Flash, then on to the validation preview.
        return redirect(`/settings/imports/${draftId}/validate`, {
          headers: await setFlash(context.cloudflare.env, {
            tone: "positive",
            message: "Mapping saved",
          }),
        });
    }
  });
}

export default function MapStep({ actionData }: Route.ComponentProps) {
  const wizard = useRouteLoaderData<typeof wizardLoader>(
    "routes/settings.imports.$draftId",
  );
  if (!wizard) return null;

  return (
    <MappingForm
      headers={wizard.draft.headers}
      previewRows={wizard.previewRows}
      detected={wizard.detected}
      savedMapping={wizard.draft.mapping}
      fieldErrors={actionData?.fieldErrors}
    />
  );
}
