// Settings → AI (#75): the per-practice AI configuration — the kill
// switch (pause classification + drafting) and the monthly budget cap —
// owner-gated behind `manage_settings`, following the #141 action recipe
// (permission check → parse → mutate+audit → flash → redirect).
//
// What this page tells the truth about:
// - The practice toggle ORs with the deployment-wide `AI_DISABLED` env
//   flag — when the operator switch is on, the page says so and the
//   practice toggle cannot override it.
// - Spend is an ESTIMATE (static price table over `ai_calls` tokens; see
//   packages/ai/src/pricing.ts) for this practice-local calendar month.
// - At ≥ 80% of the budget a banner appears here (the same state the
//   Today card reads); at 100% classification defers with the
//   urgent-keyword fallback and drafting pauses — nothing is lost, work
//   resumes when the month rolls over or the budget is raised.
import { can } from "@wellregarded/core";
import {
  getPracticeAiSettings,
  practiceAiStatus,
  updatePracticeAiSettings,
} from "@wellregarded/db";
import { data, redirect, useFetcher } from "react-router";
import { z } from "zod";

import { Field } from "~/components/form/field";
import { SubmitButton } from "~/components/form/submit-button";
import { PageHeader } from "~/components/shell/page-header";
import { aiConfigEnv } from "~/lib/ai.server";
import { withRequestDb } from "~/lib/db.server";
import { setFlash } from "~/lib/flash.server";
import { parseForm } from "~/lib/forms.server";
import { requirePracticeContext } from "~/lib/practice-context.server";
import type { Route } from "./+types/settings.ai";

export function meta() {
  return [{ title: "AI · Well Regarded" }];
}

/**
 * The form: a checkbox ("on" when checked, absent otherwise) and a
 * dollars input — empty means "no cap".
 */
const aiSettingsFormSchema = z.object({
  disabled: z.literal("on").optional(),
  monthlyBudgetDollars: z
    .string()
    .trim()
    .transform((value, ctx) => {
      if (value === "") return null;
      const dollars = Number(value);
      if (!Number.isFinite(dollars) || dollars < 0) {
        ctx.addIssue({
          code: "custom",
          message: "Enter a dollar amount (or leave empty for no cap).",
        });
        return z.NEVER;
      }
      return Math.round(dollars * 100);
    }),
});

export async function loader({ context }: Route.LoaderArgs) {
  return withRequestDb(context, async (db) => {
    // TODO(#59): requirePracticeContext is the auth seam — see its module doc.
    const ctx = await requirePracticeContext(db);
    if (!can(ctx.actor, "manage_settings", { practiceId: ctx.practiceId })) {
      throw data(null, { status: 403 });
    }
    const env = aiConfigEnv(context.cloudflare.env);
    const status = await practiceAiStatus(db, {
      practiceId: ctx.practiceId,
      env,
    });
    return {
      practiceDisabled: status.settings?.disabled === true,
      envDisabled: env.AI_DISABLED === "true" || env.AI_DISABLED === "1",
      budgetCents: status.config.monthlyBudgetCents,
      practiceBudgetCents: status.settings?.monthlyBudgetCents ?? null,
      spentCents: status.spentCents,
      budgetLevel: status.budget.level,
      budgetRatio: status.budget.ratio,
    };
  });
}

export async function action({ request, context }: Route.ActionArgs) {
  return withRequestDb(context, async (db) => {
    // 1. Permission check — in the action, always.
    const ctx = await requirePracticeContext(db);
    if (!can(ctx.actor, "manage_settings", { practiceId: ctx.practiceId })) {
      throw data(null, { status: 403 });
    }

    // 2. Parse — validation failures return 422 with fieldErrors.
    const parsed = await parseForm(aiSettingsFormSchema, request);
    if (!parsed.ok) {
      return data({ fieldErrors: parsed.fieldErrors }, { status: 422 });
    }

    // 3. Mutate + audit in one transaction (updatePracticeAiSettings
    //    writes the `practice.ai_settings_updated` audit row). Model
    //    overrides have no UI yet — preserve whatever the row carries.
    const existing = await getPracticeAiSettings(db, ctx.practiceId);
    await updatePracticeAiSettings(db, {
      practiceId: ctx.practiceId,
      settings: {
        ...(existing?.models ? { models: existing.models } : {}),
        disabled: parsed.data.disabled === "on",
        monthlyBudgetCents: parsed.data.monthlyBudgetDollars,
      },
      actor: ctx.auditActor,
    });

    // 4 + 5. Flash, then redirect.
    return redirect("/settings/ai", {
      headers: await setFlash(context.cloudflare.env, {
        tone: "positive",
        message: "AI settings saved",
      }),
    });
  });
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function BudgetBanner({
  level,
  spentCents,
  budgetCents,
}: {
  level: "ok" | "soft" | "exhausted";
  spentCents: number;
  budgetCents: number | null;
}) {
  if (level === "ok" || budgetCents === null) return null;
  const exhausted = level === "exhausted";
  return (
    <div
      data-testid="ai-budget-banner"
      className={`border px-4 py-3 text-small ${
        exhausted
          ? "border-red-700 bg-red-100 text-red-700"
          : "border-outline-strong bg-gray-50 text-ink-800"
      }`}
    >
      {exhausted ? (
        <>
          <strong>Monthly AI budget reached</strong> — {dollars(spentCents)} of{" "}
          {dollars(budgetCents)} (estimated). Classification is deferred (urgent
          items still surface via the keyword fallback) and drafting is paused
          until the month resets or you raise the budget below.
        </>
      ) : (
        <>
          <strong>Approaching the monthly AI budget</strong> —{" "}
          {dollars(spentCents)} of {dollars(budgetCents)} (estimated) used.
          Nothing changes yet; at 100% classification defers and drafting
          pauses.
        </>
      )}
    </div>
  );
}

export default function AiSettings({ loaderData }: Route.ComponentProps) {
  const {
    practiceDisabled,
    envDisabled,
    budgetCents,
    practiceBudgetCents,
    spentCents,
    budgetLevel,
  } = loaderData;
  const fetcher = useFetcher<typeof action>();
  const fieldErrors =
    fetcher.data && "fieldErrors" in fetcher.data
      ? fetcher.data.fieldErrors
      : undefined;

  return (
    <>
      <PageHeader
        overline="Settings · AI"
        title="AI"
        description="Classification and drafting run on AI. Pause it, or cap what it can spend each month."
      />
      <div className="flex max-w-130 flex-col gap-5">
        <BudgetBanner
          level={budgetLevel}
          spentCents={spentCents}
          budgetCents={budgetCents}
        />
        {envDisabled && (
          <div
            data-testid="ai-env-disabled-notice"
            className="border border-outline-strong bg-gray-50 px-4 py-3 text-small text-ink-800"
          >
            AI is currently switched off platform-wide by the operator. New
            feedback keeps flowing and is marked for classification once it is
            back — the setting below cannot override this.
          </div>
        )}
        <div className="border border-hairline bg-surface-card px-4 py-3.5">
          <span className="font-mono text-2xs font-medium uppercase tracking-label text-gray-600">
            Estimated AI spend this month
          </span>
          <p className="m-0 mt-1 font-mono text-data font-semibold tabular-nums text-ink-900">
            {dollars(spentCents)}
            {budgetCents !== null && (
              <span className="font-normal text-gray-500">
                {" "}
                of {dollars(budgetCents)}
              </span>
            )}
          </p>
          <p className="m-0 mt-1 text-small text-gray-600">
            An estimate from a static price table — close enough for a cap, not
            an invoice.
          </p>
        </div>
        <fetcher.Form
          method="post"
          action="/settings/ai"
          className="flex flex-col gap-5"
        >
          <label className="flex items-start gap-2.5 text-small text-ink-900">
            <input
              type="checkbox"
              name="disabled"
              defaultChecked={practiceDisabled}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Pause AI for this practice</span>
              <span className="mt-0.5 block text-gray-600">
                New feedback still arrives and is marked for classification
                later; urgent wording is caught by a deterministic keyword check
                in the meantime. Every change here is audited.
              </span>
            </span>
          </label>
          <Field
            name="monthlyBudgetDollars"
            label="Monthly AI budget (USD)"
            type="number"
            defaultValue={
              practiceBudgetCents === null
                ? ""
                : (practiceBudgetCents / 100).toFixed(2)
            }
            placeholder="No cap"
            hint="Optional. At 80% you get a heads-up; at 100% AI pauses until the month resets. Leave empty for no cap."
            errors={fieldErrors}
          />
          <div>
            <SubmitButton fetcher={fetcher} pendingLabel="Saving…">
              Save AI settings
            </SubmitButton>
          </div>
        </fetcher.Form>
      </div>
    </>
  );
}
