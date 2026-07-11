// Settings → Practice profile (#141): the reference CRUD page. "Go look
// at the practice profile page" should always be a complete answer, so
// this file demonstrates the whole loop — loader → form → action → zod →
// field errors → flash toast → optimistic UI — and the action follows the
// five-step recipe from docs/frontend-conventions.md:
//
//   1. permission check   2. parse   3. mutate (+ audit)   4. flash
//   5. redirect
//
// Persistence is the stubbed in-memory store for now (see
// practice-store.server.ts): the real `practices` row needs the actor that
// Epic #4 (#59) derives, and the conventions — not the storage — are this
// page's deliverable.
import { can, practiceProfileSchema } from "@wellregarded/core";
import { data, redirect, useFetcher } from "react-router";

import { Field } from "~/components/form/field";
import { SubmitButton } from "~/components/form/submit-button";
import { PageHeader } from "~/components/shell/page-header";
import { Select } from "~/components/ui/select";
import { setFlash } from "~/lib/flash.server";
import { parseForm } from "~/lib/forms.server";
import { DEMO_ACTOR, practiceStore } from "~/lib/practice-store.server";
import type { Route } from "./+types/settings.practice";

export function meta() {
  return [{ title: "Practice profile · Well Regarded" }];
}

export async function loader() {
  // TODO(auth): requireAuth — Epic #4 (#59); the id comes from the actor.
  const actor = DEMO_ACTOR;
  const practice = await practiceStore.get(actor.practiceId);
  if (!practice) {
    throw data(null, { status: 404 });
  }
  return {
    practice,
    // Rendered as a plain <select>: ~400 options is fine for M0, and the
    // runtime's own zone list can't drift from validation (core checks
    // zones the same way).
    timezones: Intl.supportedValuesOf("timeZone"),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  // 1. Permission check — in the action, always; the UI disabling a
  //    button is not a security boundary.
  //    TODO(auth): requireAuth — Epic #4 (#59) supplies the real actor.
  const actor = DEMO_ACTOR;
  if (!can(actor, "manage_settings", { practiceId: actor.practiceId })) {
    throw data(null, { status: 403 });
  }

  // 2. Parse. Validation failures are returned, never thrown: 422 with
  //    fieldErrors is user feedback, not an error condition.
  const parsed = await parseForm(practiceProfileSchema, request);
  if (!parsed.ok) {
    return data({ fieldErrors: parsed.fieldErrors }, { status: 422 });
  }

  // 3. Mutate — and audit in the same transaction once the store is
  //    Drizzle-backed. TODO(#59): audit("practice.updated", actor).
  await practiceStore.update(actor.practiceId, parsed.data);

  // 4 + 5. Flash, then redirect: the toast survives the navigation via
  //    the flash cookie the root loader reads.
  return redirect("/settings/practice", {
    headers: await setFlash(context.cloudflare.env, {
      tone: "positive",
      message: "Practice profile saved",
    }),
  });
}

export default function PracticeProfile({ loaderData }: Route.ComponentProps) {
  const { practice, timezones } = loaderData;

  // A fetcher rather than a plain <Form>: submitting must not block
  // navigation, and its in-flight formData powers the optimistic name in
  // the sidebar footer (see useOptimisticPracticeName in app-shell.tsx).
  const fetcher = useFetcher<typeof action>();
  const fieldErrors = fetcher.data?.fieldErrors;

  return (
    <>
      <PageHeader
        overline="Settings · practice profile"
        title="Practice profile"
        description="How your practice is named and reached. Public surfaces read from here."
      />
      <fetcher.Form
        method="post"
        action="/settings/practice"
        className="flex max-w-130 flex-col gap-5"
      >
        <Field
          name="name"
          label="Practice name"
          defaultValue={practice.name}
          errors={fieldErrors}
        />
        <Field
          name="phone"
          label="Phone"
          type="tel"
          defaultValue={practice.phone ?? ""}
          hint="Optional."
          errors={fieldErrors}
        />
        <Field
          name="websiteUrl"
          label="Website"
          defaultValue={practice.websiteUrl ?? ""}
          placeholder="https://example.com"
          hint="Optional. The full address, including https."
          errors={fieldErrors}
        />
        <Select
          name="timezone"
          label="Time zone"
          defaultValue={practice.timezone}
          error={fieldErrors?.timezone?.[0]}
          options={timezones.map((zone) => ({ value: zone }))}
        />
        <div>
          <SubmitButton fetcher={fetcher} pendingLabel="Saving…">
            Save changes
          </SubmitButton>
        </div>
      </fetcher.Form>
    </>
  );
}
