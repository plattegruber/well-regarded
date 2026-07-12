// Settings → Response templates (#83, Epic #10): manage_settings-gated
// CRUD over `response_templates` — list, create, edit, and soft
// deactivate (no hard delete: published responses may have originated
// from a template).
//
// THE SAVE GATE (#83 requirement 3): a template is a response waiting to
// happen, so create/edit runs the same two checks a draft faces —
// 1. the placeholder whitelist (`lintTemplateBody`): only
//    {reviewer_name} / {practice_name}; anything else rejects the save
//    with a field error (an unknown placeholder is a standing invitation
//    to wire private context into a public reply), and
// 2. the full `checkResponseSafety` over the body with neutral dummies
//    substituted ("Alex" / the practice name). `block` findings prevent
//    saving — rendered with the same SafetyFindingsList the composer
//    uses; `warn` saves only with the explicit acknowledgment.
// An unsafe template is never storable.
import { checkResponseSafety, type SafetyResult } from "@wellregarded/ai";
import {
  can,
  lintTemplateBody,
  renderTemplate,
  responseTemplateSchema,
  TEMPLATE_SAFETY_DUMMY_REVIEWER,
  TEMPLATE_TONES,
} from "@wellregarded/core";
import {
  createResponseTemplate,
  getResponseTemplate,
  listResponseTemplates,
  updateResponseTemplate,
} from "@wellregarded/db";
import { useState } from "react";
import { data, redirect, useFetcher } from "react-router";
import { z } from "zod";

import { Field } from "~/components/form/field";
import { SubmitButton } from "~/components/form/submit-button";
import {
  SafetyFindingsList,
  type SafetyNotice,
} from "~/components/responses/safety-findings";
import { Overline, PageHeader } from "~/components/shell/page-header";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Select } from "~/components/ui/select";
import { getAiProvider } from "~/lib/ai.server";
import { withRequestDb } from "~/lib/db.server";
import { setFlash } from "~/lib/flash.server";
import { parseForm } from "~/lib/forms.server";
import { requirePracticeContext } from "~/lib/practice-context.server";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/settings.templates";

export function meta() {
  return [{ title: "Response templates · Well Regarded" }];
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ context }: Route.LoaderArgs) {
  return withRequestDb(context, async (db) => {
    // TODO(#59): requirePracticeContext is the auth seam — see its module doc.
    const ctx = await requirePracticeContext(db);
    if (!can(ctx.actor, "manage_settings", { practiceId: ctx.practiceId })) {
      throw data(null, { status: 403 });
    }
    const templates = await listResponseTemplates(db, ctx.practiceId);
    return {
      templates: templates.map((template) => ({
        id: template.id,
        name: template.name,
        body: template.body,
        tone: template.tone,
        active: template.active,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

const templateFields = responseTemplateSchema.shape;

const actionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("create"),
    ...templateFields,
    acknowledgeWarnings: z.literal("yes").optional(),
  }),
  z.object({
    intent: z.literal("update"),
    templateId: z.string().uuid(),
    ...templateFields,
    acknowledgeWarnings: z.literal("yes").optional(),
  }),
  z.object({ intent: z.literal("deactivate"), templateId: z.string().uuid() }),
  z.object({ intent: z.literal("activate"), templateId: z.string().uuid() }),
]);

function toSafetyNotice(
  safety: SafetyResult,
  acknowledged: boolean,
): SafetyNotice {
  return {
    level: safety.level,
    needsAcknowledgement: safety.level === "warn" && !acknowledged,
    findings: safety.findings.map((finding) => ({
      code: finding.code,
      reason: finding.reason,
      suggestion: finding.suggestion,
      level: finding.level,
    })),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  return withRequestDb(context, async (db) => {
    // 1. Permission check — manage_settings, in the action, always.
    const ctx = await requirePracticeContext(db);
    if (!can(ctx.actor, "manage_settings", { practiceId: ctx.practiceId })) {
      throw data(null, { status: 403 });
    }

    // 2. Parse — returned 422s, never thrown.
    const parsed = await parseForm(actionSchema, request);
    if (!parsed.ok) {
      return data({ fieldErrors: parsed.fieldErrors }, { status: 422 });
    }
    const input = parsed.data;

    const saved = async (message: string) =>
      redirect("/settings/templates", {
        headers: await setFlash(context.cloudflare.env, {
          tone: "positive",
          message,
        }),
      });

    // Soft active flips need no safety re-run — the body is unchanged.
    if (input.intent === "deactivate" || input.intent === "activate") {
      const updated = await updateResponseTemplate(db, {
        practiceId: ctx.practiceId,
        templateId: input.templateId,
        patch: { active: input.intent === "activate" },
        actor: ctx.auditActor,
      });
      if (!updated) throw data(null, { status: 404 });
      return saved(
        input.intent === "activate"
          ? "Template reactivated"
          : "Template deactivated — it stays in this list, hidden from the composer",
      );
    }

    // 3a. The placeholder whitelist (the template linter).
    const lint = lintTemplateBody(input.body);
    if (lint.unknownPlaceholders.length > 0) {
      return data(
        {
          fieldErrors: {
            body: [
              `Unknown placeholder ${lint.unknownPlaceholders
                .map((name) => `{${name}}`)
                .join(
                  ", ",
                )} — only {reviewer_name} and {practice_name} are supported.`,
            ],
          },
        },
        { status: 422 },
      );
    }

    // 3b. The save-time safety gate: check the body as a reader would see
    // it — placeholders substituted with neutral dummies. Deterministic
    // blocks hold even when the AI layer is down (degraded mode).
    const rendered = renderTemplate(input.body, {
      reviewer_name: TEMPLATE_SAFETY_DUMMY_REVIEWER,
      practice_name: ctx.practiceName,
    });
    const safety = await checkResponseSafety(
      rendered,
      { text: null, rating: null, visibility: "public" },
      {
        // Gated (#75): kill switch / budget cap degrade to
        // deterministic-only — an unsafe template still cannot save.
        provider: getAiProvider(context.cloudflare.env, db, {
          practiceId: ctx.practiceId,
        }),
        practiceId: ctx.practiceId,
        requestId: context.requestId,
      },
    );
    const acknowledged = input.acknowledgeWarnings === "yes";
    if (
      safety.level === "block" ||
      (safety.level === "warn" && !acknowledged)
    ) {
      return data(
        { safety: toSafetyNotice(safety, acknowledged) },
        { status: 422 },
      );
    }

    // 4. Mutate + audit (inside the query helpers), flash, redirect.
    if (input.intent === "create") {
      await createResponseTemplate(db, {
        practiceId: ctx.practiceId,
        name: input.name,
        body: input.body,
        tone: input.tone,
        actor: ctx.auditActor,
      });
      return saved("Template created");
    }

    const existing = await getResponseTemplate(
      db,
      ctx.practiceId,
      input.templateId,
    );
    if (!existing) throw data(null, { status: 404 });
    await updateResponseTemplate(db, {
      practiceId: ctx.practiceId,
      templateId: input.templateId,
      patch: { name: input.name, body: input.body, tone: input.tone },
      actor: ctx.auditActor,
    });
    return saved("Template saved");
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type ActionData =
  | { fieldErrors: Record<string, string[]> }
  | { safety: SafetyNotice }
  | undefined;

const TONE_OPTIONS = TEMPLATE_TONES.map((tone) => ({ value: tone }));

/** Shared body of the create and edit forms: fields + the safety bounce. */
function TemplateFields({
  fetcher,
  defaults,
}: {
  fetcher: ReturnType<typeof useFetcher<ActionData>>;
  defaults?: { name: string; body: string; tone: string };
}) {
  const dataOut = fetcher.data;
  const fieldErrors =
    dataOut && "fieldErrors" in dataOut ? dataOut.fieldErrors : undefined;
  const safety = dataOut && "safety" in dataOut ? dataOut.safety : undefined;

  return (
    <>
      <Field
        name="name"
        label="Name"
        defaultValue={defaults?.name}
        errors={fieldErrors}
      />
      <Select
        name="tone"
        label="Tone"
        defaultValue={defaults?.tone ?? "warm"}
        options={TONE_OPTIONS}
        error={fieldErrors?.tone?.[0]}
      />
      <div className="flex flex-col gap-1.5">
        <label className="font-mono text-label font-medium uppercase tracking-label text-gray-600">
          Body
          <textarea
            name="body"
            rows={4}
            required
            defaultValue={defaults?.body}
            className={cn(
              "mt-1.5 block w-full resize-y border bg-surface-card px-3 py-2.5",
              "font-sans text-body normal-case tracking-normal text-ink-900",
              "focus:shadow-focus-ring focus:outline-none",
              fieldErrors?.body
                ? "border-status-negative"
                : "border-outline-strong focus:border-accent-600",
            )}
          />
        </label>
        {fieldErrors?.body?.[0] ? (
          <span className="text-small text-danger">{fieldErrors.body[0]}</span>
        ) : (
          <span className="text-small text-gray-500">
            {
              "{reviewer_name} and {practice_name} fill in when inserted — no other placeholders."
            }
          </span>
        )}
      </div>

      {safety && safety.findings.length > 0 && (
        <div data-testid="template-safety">
          <p className="m-0 mb-2 text-small font-medium text-ink-800">
            {safety.level === "block"
              ? "This template can't be saved — a reply built from it would be blocked:"
              : "The safety check found warnings on this template:"}
          </p>
          <SafetyFindingsList findings={safety.findings} />
        </div>
      )}
      {safety?.needsAcknowledgement && (
        <label className="flex items-start gap-2 text-small text-ink-800">
          <input
            type="checkbox"
            name="acknowledgeWarnings"
            value="yes"
            required
            className="mt-0.5"
            data-testid="acknowledge-warnings"
          />
          I reviewed the warnings above and want to save anyway.
        </label>
      )}
    </>
  );
}

function TemplateCard({
  template,
}: {
  template: Route.ComponentProps["loaderData"]["templates"][number];
}) {
  const fetcher = useFetcher<ActionData>();
  const activeFetcher = useFetcher();
  const [editing, setEditing] = useState(false);

  return (
    <Card
      title={template.name}
      className={template.active ? undefined : "opacity-60"}
      action={
        <span className="flex items-center gap-2">
          <Badge tone="neutral">{template.tone}</Badge>
          {!template.active && <Badge tone="caution">Deactivated</Badge>}
        </span>
      }
    >
      <div className="flex flex-col gap-3" data-testid="template-card">
        {editing ? (
          <fetcher.Form
            method="post"
            action="/settings/templates"
            className="flex flex-col gap-4"
          >
            <input type="hidden" name="intent" value="update" />
            <input type="hidden" name="templateId" value={template.id} />
            <TemplateFields fetcher={fetcher} defaults={template} />
            <div className="flex gap-3">
              <SubmitButton fetcher={fetcher} size="sm">
                Save changes
              </SubmitButton>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
            </div>
          </fetcher.Form>
        ) : (
          <>
            <p className="m-0 whitespace-pre-wrap font-mono text-quote text-ink-800">
              {template.body}
            </p>
            <div className="flex gap-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
              <activeFetcher.Form method="post" action="/settings/templates">
                <input
                  type="hidden"
                  name="intent"
                  value={template.active ? "deactivate" : "activate"}
                />
                <input type="hidden" name="templateId" value={template.id} />
                <Button
                  type="submit"
                  variant="ghost"
                  size="sm"
                  disabled={activeFetcher.state !== "idle"}
                >
                  {template.active ? "Deactivate" : "Reactivate"}
                </Button>
              </activeFetcher.Form>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

export default function ResponseTemplates({
  loaderData,
}: Route.ComponentProps) {
  const createFetcher = useFetcher<ActionData>();

  return (
    <>
      <PageHeader
        overline="Settings · response templates"
        title="Response templates"
        description="Reusable reply shapes for the composer. Every template passes the same safety check a draft does — the safe shape is the easy shape."
      />
      <div className="flex max-w-3xl flex-col gap-5">
        {loaderData.templates.length === 0 ? (
          <p className="m-0 text-small text-gray-600">
            No templates yet. The starter set arrives with a new practice;
            create one below.
          </p>
        ) : (
          loaderData.templates.map((template) => (
            <TemplateCard key={template.id} template={template} />
          ))
        )}

        <Card title="New template">
          <createFetcher.Form
            method="post"
            action="/settings/templates"
            className="flex flex-col gap-4"
          >
            <input type="hidden" name="intent" value="create" />
            <Overline>Create</Overline>
            <TemplateFields fetcher={createFetcher} />
            <div>
              <SubmitButton fetcher={createFetcher} pendingLabel="Checking…">
                Create template
              </SubmitButton>
            </div>
          </createFetcher.Form>
        </Card>
      </div>
    </>
  );
}
