// Wizard index (#134): `/settings/imports/:draftId` resumes at the
// draft's saved step — a closed tab reopens where the office manager left
// off. Redirect-only; the layout's loader has already 404'd unknown ids
// and bounced terminal drafts.
import { getImportDraft } from "@wellregarded/db";
import { data, redirect } from "react-router";

import { withRequestDb } from "~/lib/db.server";
import { requireDraftIdParam } from "~/lib/import-wizard.server";
import { requirePracticeContext } from "~/lib/practice-context.server";
import type { Route } from "./+types/settings.imports.$draftId._index";

export async function loader({ params, context }: Route.LoaderArgs) {
  const draftId = requireDraftIdParam(params.draftId);
  return withRequestDb(context, async (db) => {
    const ctx = await requirePracticeContext(db);
    const draft = await getImportDraft(db, ctx.practiceId, draftId);
    if (!draft) throw data(null, { status: 404 });
    return redirect(
      `/settings/imports/${draft.id}/${draft.wizardStep ?? "map"}`,
    );
  });
}
