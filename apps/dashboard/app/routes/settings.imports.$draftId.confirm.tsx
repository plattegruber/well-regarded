// Wizard step 4 — confirm & start (#134). The summary card restates every
// decision, and "Start import" runs `confirmImportDraft`, whose shared
// `importStartIssues` guardrail re-validates mapping completeness and the
// consent choice server-side (issue req. 6) — the wizard can never
// confirm a draft the server would reject, because both ask the same
// function. On success one `wr-csv-import` Workflow instance is created
// (#135, docs/csv-import.md § Triggering) — AFTER the commit and
// non-fatal, since `confirmed` is the durable state the Workflow consumes
// and a failed create leaves a retriable draft.
//
// On success the user lands on the imports LIST (#137), not the report
// page: the Workflow opens the `import_runs` row asynchronously in its
// validate step, so no run id exists yet at confirm time. The list shows
// the running import within one poll and links through to its report.
import {
  can,
  IMPORT_TARGET_FIELDS,
  mappingConsentChoice,
  mappingVisibilityConstant,
} from "@wellregarded/core";
import { confirmImportDraft } from "@wellregarded/db";
import { data, Form, Link, redirect, useRouteLoaderData } from "react-router";

import { SubmitButton } from "~/components/form/submit-button";
import { Badge } from "~/components/ui/badge";
import { Card } from "~/components/ui/card";
import { withRequestDb } from "~/lib/db.server";
import { setFlash } from "~/lib/flash.server";
import { TARGET_FIELD_LABELS } from "~/lib/import-mapping-form";
import { requireDraftIdParam } from "~/lib/import-wizard.server";
import { requirePracticeContext } from "~/lib/practice-context.server";
import type { Route } from "./+types/settings.imports.$draftId.confirm";
import {
  formatByteSize,
  type loader as wizardLoader,
} from "./settings.imports.$draftId";

export function meta() {
  return [{ title: "Confirm import · Well Regarded" }];
}

export async function action({ params, context }: Route.ActionArgs) {
  const draftId = requireDraftIdParam(params.draftId);

  return withRequestDb(context, async (db) => {
    // 1. Permission check — in the action, always.
    const ctx = await requirePracticeContext(db);
    if (!can(ctx.actor, "manage_settings", { practiceId: ctx.practiceId })) {
      throw data(null, { status: 403 });
    }

    // 2 + 3. The guardrail IS the parse here (the draft holds the state);
    //    mutate + audit in one transaction inside the helper.
    const result = await confirmImportDraft(db, {
      practiceId: ctx.practiceId,
      actor: ctx.auditActor,
      draftId,
    });

    switch (result.outcome) {
      case "not_found":
        throw data(null, { status: 404 });
      case "not_editable":
        throw redirect(`/settings/imports/${draftId}`);
      case "blocked":
        // Returned, not thrown: these are fix-it messages for the human.
        return data({ issues: result.issues }, { status: 422 });
      case "ok": {
        // Kick off the import Workflow (#135). Optional binding: a local
        // dev session without the jobs worker still confirms the draft.
        const workflow = context.cloudflare.env.CSV_IMPORT;
        if (workflow) {
          try {
            await workflow.create({
              params: {
                importDraftId: draftId,
                practiceId: ctx.practiceId,
                requestId: context.requestId,
              },
            });
          } catch (error) {
            // Non-fatal by design (see module doc): confirmed is durable.
            context.logger.error("csv-import workflow create failed", {
              importDraftId: draftId,
              error,
            });
          }
        }
        // 4 + 5. Flash, then to the imports list (#137) — the run id is
        // not known yet (see module doc); the list polls it into view.
        return redirect("/settings/imports", {
          headers: await setFlash(context.cloudflare.env, {
            tone: "positive",
            message: "Import confirmed — processing will begin shortly",
          }),
        });
      }
    }
  });
}

export default function ConfirmStep({ actionData }: Route.ComponentProps) {
  const wizard = useRouteLoaderData<typeof wizardLoader>(
    "routes/settings.imports.$draftId",
  );
  if (!wizard) return null;
  const { draft, validation, consentRequired } = wizard;

  const mapping = draft.mapping;
  const consentChoice = mapping ? mappingConsentChoice(mapping) : null;
  const visibility = mapping ? mappingVisibilityConstant(mapping) : null;
  const mappedFields = mapping
    ? IMPORT_TARGET_FIELDS.flatMap((field) => {
        const entry = mapping[field];
        if (entry === undefined) return [];
        return [
          {
            field,
            detail:
              "column" in entry
                ? `from "${entry.column}"`
                : `${entry.constant} (whole file)`,
          },
        ];
      })
    : [];

  const issues = actionData?.issues;

  return (
    <div className="flex max-w-160 flex-col gap-4">
      <Card title="Ready to import">
        <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-small">
          <dt className="font-mono text-2xs uppercase tracking-label text-gray-500">
            File
          </dt>
          <dd className="m-0 text-ink-900">
            <span className="font-mono">{draft.originalFilename}</span> ·{" "}
            {formatByteSize(draft.byteSize)}
          </dd>

          <dt className="font-mono text-2xs uppercase tracking-label text-gray-500">
            Sample check
          </dt>
          <dd className="m-0 text-ink-900">
            {validation
              ? `${validation.okCount} of ${validation.rowCount} preview rows look good`
              : "Not mapped yet"}
          </dd>

          <dt className="font-mono text-2xs uppercase tracking-label text-gray-500">
            Fields
          </dt>
          <dd className="m-0 text-ink-900">
            {mappedFields.length === 0 ? (
              "Not mapped yet"
            ) : (
              <ul className="m-0 list-none p-0">
                {mappedFields.map(({ field, detail }) => (
                  <li key={field}>
                    {TARGET_FIELD_LABELS[field]}{" "}
                    <span className="text-gray-500">{detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </dd>

          <dt className="font-mono text-2xs uppercase tracking-label text-gray-500">
            Destination
          </dt>
          <dd className="m-0 text-ink-900">
            {visibility === "public"
              ? "Signals, as public reviews from this CSV"
              : visibility === "private"
                ? "Signals, as private feedback from this CSV"
                : "Signals, visibility read per row from the file"}
          </dd>

          {consentRequired !== false && (
            <>
              <dt className="font-mono text-2xs uppercase tracking-label text-gray-500">
                Consent
              </dt>
              <dd className="m-0 text-ink-900">
                {consentChoice === "practice_attested" ? (
                  <>
                    <Badge tone="positive">documented permission</Badge>
                    {draft.attestationNote && (
                      <span className="mt-1 block text-gray-600">
                        {draft.attestationNote}
                      </span>
                    )}
                  </>
                ) : consentChoice === "imported_unknown" ? (
                  <>
                    <Badge tone="caution">no documented permission</Badge>
                    <span className="mt-1 block text-gray-600">
                      Private insights only — never published without the
                      patient's permission.
                    </span>
                  </>
                ) : (
                  "Not decided yet"
                )}
              </dd>
            </>
          )}
        </dl>
      </Card>

      {issues && issues.length > 0 && (
        <div role="alert" className="border border-status-negative p-4">
          <p className="m-0 mb-2 text-small font-semibold text-ink-900">
            A few things before this can start:
          </p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-small text-ink-900">
            {issues.map((issue) => (
              <li key={issue.code}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}

      <Form method="post" className="flex items-center gap-3">
        <SubmitButton pendingLabel="Starting…">Start import</SubmitButton>
        <Link
          to={`/settings/imports/${draft.id}/consent`}
          className="text-small text-ink-900 underline"
        >
          Back
        </Link>
      </Form>
      <p className="m-0 text-small text-gray-500">
        Starting locks the mapping and begins processing the whole file. A
        report of what was created, merged, and skipped follows.
      </p>
    </div>
  );
}
