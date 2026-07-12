// Step 3 of the mapping wizard (#134): the bulk consent choice for
// private feedback / PII imports. The structural rule from Epic #8: no
// documented consent ⇒ `consent: unknown` ⇒ analyzable, never publishable,
// until a consent record exists (Epic #12's re-permission flow).
//
// Two deliberate constraints, both from the issue:
// - NO default selection — the office manager must choose.
// - The publishability consequence sits under each option, in plain
//   language. This copy is the issue's spec; changes need PM sign-off.
import type { ImportConsentHint } from "@wellregarded/core";
import { useState } from "react";
import { Form } from "react-router";

import { SubmitButton } from "~/components/form/submit-button";
import type { FieldErrors } from "~/lib/forms.server";
import { cn } from "~/lib/utils";

export interface ConsentFormProps {
  defaultChoice: ImportConsentHint | null;
  defaultNote: string | null;
  fieldErrors?: FieldErrors;
}

export function ConsentForm({
  defaultChoice,
  defaultNote,
  fieldErrors,
}: ConsentFormProps) {
  const [choice, setChoice] = useState<ImportConsentHint | null>(defaultChoice);
  const choiceError = fieldErrors?.consentChoice?.[0];
  const noteError = fieldErrors?.attestationNote?.[0];

  const optionClass = (selected: boolean) =>
    cn(
      "flex cursor-pointer flex-col gap-2 border p-4",
      selected ? "border-ink-900 bg-gray-50" : "border-outline-strong",
    );

  return (
    <Form method="post" className="flex max-w-160 flex-col gap-4">
      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className="mb-3 p-0 text-body text-ink-900">
          Do you have documented permission from these patients to share their
          feedback?
        </legend>

        <label className={optionClass(choice === "practice_attested")}>
          <span className="flex items-baseline gap-2.5">
            <input
              type="radio"
              name="consentChoice"
              value="practice_attested"
              checked={choice === "practice_attested"}
              onChange={() => setChoice("practice_attested")}
              required
            />
            <span className="font-semibold text-ink-900">
              We have documented permission
            </span>
          </span>
          <span className="pl-6 text-small text-gray-600">
            These can be suggested for publishing after review.
          </span>
          {choice === "practice_attested" && (
            <span className="flex flex-col gap-1.5 pl-6">
              <label
                htmlFor="attestation-note"
                className="font-mono text-label font-medium uppercase tracking-label text-gray-600"
              >
                Where does the permission live?
              </label>
              <textarea
                id="attestation-note"
                name="attestationNote"
                defaultValue={defaultNote ?? ""}
                required
                rows={2}
                placeholder="For example: signed intake forms 2021–2024"
                aria-invalid={noteError ? true : undefined}
                aria-describedby={
                  noteError ? "attestation-note-error" : undefined
                }
                className="w-full border border-outline-strong bg-surface-card px-3 py-2 font-sans text-small text-ink-900 focus:shadow-focus-ring focus:outline-none"
              />
              {noteError && (
                <span
                  id="attestation-note-error"
                  role="alert"
                  className="text-small text-danger"
                >
                  {noteError}
                </span>
              )}
            </span>
          )}
        </label>

        <label className={optionClass(choice === "imported_unknown")}>
          <span className="flex items-baseline gap-2.5">
            <input
              type="radio"
              name="consentChoice"
              value="imported_unknown"
              checked={choice === "imported_unknown"}
              onChange={() => setChoice("imported_unknown")}
              required
            />
            <span className="font-semibold text-ink-900">
              We don't have documented permission
            </span>
          </span>
          <span className="pl-6 text-small text-gray-600">
            These will be used for private insights only. They can never be
            published unless the patient grants permission later (we'll help you
            ask, in a later release).
          </span>
        </label>
      </fieldset>

      {choiceError && (
        <p role="alert" className="m-0 text-small text-danger">
          {choiceError}
        </p>
      )}

      <div>
        <SubmitButton pendingLabel="Saving…">Continue</SubmitButton>
      </div>
    </Form>
  );
}
