// Add signal (#138): manual single-signal entry — the compliment from a
// phone call or a front-desk card, captured in under a minute. Submits to
// `POST /api/signals/manual` (browser → api worker, the CSV upload
// screen's transport precedent), which stores the payload as a raw
// artifact and enqueues it onto the STANDARD pipeline — classification is
// async, and the confirmation says so instead of faking instant
// availability.
//
// Visibility is deliberately absent: manual entries are `private`
// feedback at M1 (no public toggle — issue #138 requirement 1); the
// adapter pins it.
//
// TODO(auth): requireAuth — Epic #4 (#59). Same stubbed-session caveat as
// the CSV upload screen: the API call authenticates only where a session
// cookie is present.
import {
  can,
  MANUAL_SOURCE_SUGGESTIONS,
  type ManualConsent,
  type ManualSignalForm,
  manualSignalFormSchema,
} from "@wellregarded/core";
import { listSignalFilterOptions } from "@wellregarded/db";
import { useState } from "react";
import { data, Link } from "react-router";
import { PageHeader } from "~/components/shell/page-header";
import { ManualConsentSection } from "~/components/signals/manual-consent-section";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { withRequestDb } from "~/lib/db.server";
import { requirePracticeContext } from "~/lib/practice-context.server";
import type { Route } from "./+types/signals.new";

export function meta() {
  return [{ title: "Add signal · Well Regarded" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  return withRequestDb(context, async (db) => {
    const ctx = await requirePracticeContext(db);
    // Anyone who can view signals can add one; the attestation choice
    // alone is additionally gated (the API re-checks both server-side).
    if (!ctx.viewer.viewPrivateFeedback) throw data(null, { status: 403 });
    const options = await listSignalFilterOptions(db, ctx.practiceId);
    return {
      apiUrl:
        (context.cloudflare.env.API_URL as string | undefined) ??
        "http://localhost:8787",
      canAttest: can(ctx.actor, "manage_consent", {
        practiceId: ctx.practiceId,
      }),
      locations: options.locations,
      providers: options.providers,
      today: new Date().toISOString().slice(0, 10),
    };
  });
}

type SubmitState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "done"; importRunId: string }
  | { phase: "error"; message: string };

type FieldErrors = Partial<Record<string, string>>;

/** Map zod issues onto the form's field slots. */
function fieldErrorsFrom(
  issues: Array<{ path: string; message: string }>,
): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const key = issue.path === "" ? "form" : issue.path.split(".")[0];
    if (key && errors[key] === undefined) errors[key] = issue.message;
    if (issue.path.startsWith("consent.note"))
      errors.consentNote = issue.message;
    if (issue.path.startsWith("consent.channels"))
      errors.consentChannels = issue.message;
  }
  return errors;
}

/** Build the payload from form state — omitting empties, trimming, and
 * lowercasing the email (light client normalization; the real
 * normalization/encryption is the PII layer's job). */
export function buildManualPayload(state: {
  text: string;
  occurredOn: string;
  sourceDescription: string;
  locationId: string;
  providerId: string;
  patientName: string;
  patientEmail: string;
  patientPhone: string;
  consent: ManualConsent;
}): ManualSignalForm {
  const name = state.patientName.trim();
  const email = state.patientEmail.trim().toLowerCase();
  const phone = state.patientPhone.trim();
  const patient =
    name || email || phone
      ? {
          ...(name ? { name } : {}),
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
        }
      : undefined;
  return {
    text: state.text.trim(),
    occurredOn: state.occurredOn,
    sourceDescription: state.sourceDescription.trim(),
    ...(state.locationId ? { locationId: state.locationId } : {}),
    ...(state.providerId ? { providerId: state.providerId } : {}),
    ...(patient !== undefined ? { patient } : {}),
    consent:
      state.consent.choice === "practice_attested"
        ? { ...state.consent, note: state.consent.note.trim() }
        : state.consent,
  } as ManualSignalForm;
}

export default function NewSignal({ loaderData }: Route.ComponentProps) {
  const { apiUrl, canAttest, locations, providers, today } = loaderData;
  const [text, setText] = useState("");
  const [occurredOn, setOccurredOn] = useState(today);
  const [sourceDescription, setSourceDescription] = useState("");
  const [locationId, setLocationId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [patientName, setPatientName] = useState("");
  const [patientEmail, setPatientEmail] = useState("");
  const [patientPhone, setPatientPhone] = useState("");
  const [consent, setConsent] = useState<ManualConsent>({ choice: "unknown" });
  const [state, setState] = useState<SubmitState>({ phase: "idle" });
  const [errors, setErrors] = useState<FieldErrors>({});

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const payload = buildManualPayload({
      text,
      occurredOn,
      sourceDescription,
      locationId,
      providerId,
      patientName,
      patientEmail,
      patientPhone,
      consent,
    });
    const parsed = manualSignalFormSchema.safeParse(payload);
    if (!parsed.success) {
      setErrors(
        fieldErrorsFrom(
          parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        ),
      );
      return;
    }
    setErrors({});
    setState({ phase: "submitting" });
    try {
      const response = await fetch(`${apiUrl}/api/signals/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Same-site session cookie authenticates the staff call.
        credentials: "include",
        body: JSON.stringify(parsed.data),
      });
      const body = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (response.status === 201 && typeof body.importRunId === "string") {
        setState({ phase: "done", importRunId: body.importRunId });
      } else if (
        typeof body.message === "string" ||
        typeof body.error === "string"
      ) {
        setState({
          phase: "error",
          message:
            typeof body.message === "string"
              ? body.message
              : "That couldn't be saved. Check the form and try again.",
        });
      } else {
        setState({
          phase: "error",
          message: "That couldn't be saved. Check the form and try again.",
        });
      }
    } catch {
      setState({
        phase: "error",
        message: "Couldn't reach the server. Check your connection and retry.",
      });
    }
  }

  if (state.phase === "done") {
    return (
      <>
        <PageHeader overline="Signals" title="Added" />
        <Card title="Added — it'll appear in Signals shortly" sunken>
          <p className="m-0 mb-3.5 max-w-130 text-small text-gray-600">
            It's being classified and checked against what you already have —
            usually done within a minute.
          </p>
          <div className="flex items-center gap-4">
            <Link
              to="/signals"
              className="inline-flex items-center border border-ink-900 bg-ink-900 px-4.5 py-3 font-mono text-xs font-semibold uppercase leading-none tracking-label text-on-dark no-underline hover:bg-ink-700"
            >
              Back to signals
            </Link>
            <Link
              to="/signals/new"
              reloadDocument
              className="text-small text-ink-900 underline"
            >
              Add another
            </Link>
          </div>
        </Card>
      </>
    );
  }

  const submitting = state.phase === "submitting";

  return (
    <>
      <PageHeader
        overline="Signals"
        title="Add signal"
        description="A compliment from a phone call, an email, or a card — capture it before it disappears. It stays private feedback."
      />
      <form
        onSubmit={handleSubmit}
        className="flex max-w-160 flex-col gap-4"
        data-testid="manual-entry-form"
        noValidate
      >
        <Card title="What was said">
          <div className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="signal-text"
                className="font-mono text-label font-medium uppercase tracking-label text-gray-600"
              >
                The feedback, in the patient's words
              </label>
              <textarea
                id="signal-text"
                name="text"
                rows={4}
                required
                value={text}
                onChange={(event) => setText(event.target.value)}
                aria-invalid={errors.text ? true : undefined}
                className="w-full border border-outline-strong bg-surface-card px-3 py-2 font-sans text-body text-ink-900 focus:shadow-focus-ring focus:outline-none"
              />
              {errors.text && (
                <span role="alert" className="text-small text-danger">
                  {errors.text}
                </span>
              )}
            </div>
            <Input
              label="When it happened"
              type="date"
              name="occurredOn"
              required
              max={today}
              value={occurredOn}
              onChange={(event) => setOccurredOn(event.target.value)}
              error={errors.occurredOn ?? ""}
              className="max-w-60"
            />
            <div className="flex flex-col gap-1.5">
              <Input
                label="Where it came from"
                name="sourceDescription"
                required
                placeholder="For example: phone call"
                value={sourceDescription}
                onChange={(event) => setSourceDescription(event.target.value)}
                error={errors.sourceDescription ?? ""}
                className="max-w-100"
              />
              <div className="flex flex-wrap gap-2">
                {MANUAL_SOURCE_SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    data-testid="source-suggestion"
                    onClick={() => setSourceDescription(suggestion)}
                    className="cursor-pointer border border-outline-strong bg-surface-card px-2.5 py-1.5 font-mono text-2xs uppercase tracking-label text-gray-600 hover:border-ink-900 hover:text-ink-900"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Card>

        <Card title="Who and where (optional)">
          <div className="flex flex-col gap-3.5">
            <div className="flex flex-wrap gap-3.5">
              <Select
                label="Location"
                name="locationId"
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
                options={[
                  { value: "", label: "Not tied to a location" },
                  ...locations.map((row) => ({
                    value: row.id,
                    label: row.name,
                  })),
                ]}
                className="min-w-60"
              />
              <Select
                label="Provider"
                name="providerId"
                value={providerId}
                onChange={(event) => setProviderId(event.target.value)}
                options={[
                  { value: "", label: "Not about one provider" },
                  ...providers.map((row) => ({
                    value: row.id,
                    label: row.name,
                  })),
                ]}
                className="min-w-60"
              />
            </div>
            <p className="m-0 text-small text-gray-500">
              Patient details stay in the protected patient record — they never
              show on the signal itself without permission.
            </p>
            <div className="flex flex-wrap gap-3.5">
              <Input
                label="Patient name"
                name="patientName"
                value={patientName}
                onChange={(event) => setPatientName(event.target.value)}
                className="min-w-60"
              />
              <Input
                label="Patient email"
                type="email"
                name="patientEmail"
                value={patientEmail}
                onChange={(event) => setPatientEmail(event.target.value)}
                error={errors.patient ?? ""}
                className="min-w-60"
              />
              <Input
                label="Patient phone"
                type="tel"
                name="patientPhone"
                value={patientPhone}
                onChange={(event) => setPatientPhone(event.target.value)}
                className="min-w-60"
              />
            </div>
          </div>
        </Card>

        {text.trim().length > 0 && (
          <Card title="Permission to share">
            <ManualConsentSection
              value={consent}
              onChange={setConsent}
              canAttest={canAttest}
              errors={{
                ...(errors.consentChannels
                  ? { channels: errors.consentChannels }
                  : {}),
                ...(errors.consentNote ? { note: errors.consentNote } : {}),
              }}
            />
          </Card>
        )}

        {state.phase === "error" && (
          <p role="alert" className="m-0 text-small text-danger">
            {state.message}
          </p>
        )}

        <div className="flex items-center gap-4">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Adding…" : "Add signal"}
          </Button>
          <Link to="/signals" className="text-small text-ink-900 underline">
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
