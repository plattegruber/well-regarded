// Inline consent capture for manual entry (#138): shown once there is
// feedback text, defaulting to "No / Not asked" (which records NOTHING —
// the absence of a consents row IS the state). Choosing "Yes, the practice
// attests" reveals the channel checkboxes (Epic #3's consents vocabulary)
// and a required where-does-the-permission-live note. Plain-language
// consequence copy follows #134's consent step.
import {
  CONSENT_CHANNEL_LABELS,
  CONSENT_CHANNELS,
  type ConsentChannel,
  type ManualConsent,
} from "@wellregarded/core";

import { cn } from "~/lib/utils";

export interface ManualConsentSectionProps {
  value: ManualConsent;
  onChange: (value: ManualConsent) => void;
  /**
   * Whether this staff member may record an attestation (`manage_consent`
   * in the permission matrix). The FORM stays open to everyone who can
   * view signals; only this choice is gated (#138 requirement 6).
   */
  canAttest: boolean;
  errors?: { channels?: string; note?: string };
}

export function ManualConsentSection({
  value,
  onChange,
  canAttest,
  errors,
}: ManualConsentSectionProps) {
  const attested = value.choice === "practice_attested";

  const optionClass = (selected: boolean, disabled = false) =>
    cn(
      "flex flex-col gap-2 border p-4",
      selected ? "border-ink-900 bg-gray-50" : "border-outline-strong",
      disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
    );

  const toggleChannel = (channel: ConsentChannel, checked: boolean) => {
    if (value.choice !== "practice_attested") return;
    const channels = checked
      ? [...value.channels, channel]
      : value.channels.filter((existing) => existing !== channel);
    onChange({ ...value, channels });
  };

  return (
    <fieldset
      data-testid="manual-consent"
      className="m-0 flex flex-col gap-3 border-0 p-0"
    >
      <legend className="mb-3 p-0 text-body text-ink-900">
        Did the patient give permission to share this?
      </legend>

      <label className={optionClass(!attested)}>
        <span className="flex items-baseline gap-2.5">
          <input
            type="radio"
            name="consentChoice"
            value="unknown"
            checked={!attested}
            onChange={() => onChange({ choice: "unknown" })}
          />
          <span className="font-semibold text-ink-900">No / Not asked</span>
        </span>
        <span className="pl-6 text-small text-gray-600">
          Kept for private insights only. It can never be published unless the
          patient grants permission later.
        </span>
      </label>

      <label
        className={optionClass(attested, !canAttest)}
        data-testid="attest-option"
      >
        <span className="flex items-baseline gap-2.5">
          <input
            type="radio"
            name="consentChoice"
            value="practice_attested"
            checked={attested}
            disabled={!canAttest}
            onChange={() =>
              onChange({ choice: "practice_attested", channels: [], note: "" })
            }
          />
          <span className="font-semibold text-ink-900">
            Yes — the practice attests
          </span>
        </span>
        <span className="pl-6 text-small text-gray-600">
          {canAttest
            ? "Can be suggested for publishing on the channels you pick, after review."
            : "Your role can't record consent on the patient's behalf — ask an office manager to add it."}
        </span>

        {attested && value.choice === "practice_attested" && (
          <span
            data-testid="attest-details"
            className="flex flex-col gap-3 pl-6"
          >
            <span className="flex flex-col gap-1.5">
              <span className="font-mono text-label font-medium uppercase tracking-label text-gray-600">
                Where may it be used?
              </span>
              <span className="flex flex-wrap gap-3">
                {CONSENT_CHANNELS.map((channel) => (
                  <label
                    key={channel}
                    className="flex items-center gap-1.5 text-small text-ink-900"
                  >
                    <input
                      type="checkbox"
                      name="consentChannels"
                      value={channel}
                      checked={value.channels.includes(channel)}
                      onChange={(event) =>
                        toggleChannel(channel, event.target.checked)
                      }
                    />
                    {CONSENT_CHANNEL_LABELS[channel]}
                  </label>
                ))}
              </span>
              {errors?.channels && (
                <span role="alert" className="text-small text-danger">
                  {errors.channels}
                </span>
              )}
            </span>
            <span className="flex flex-col gap-1.5">
              <label
                htmlFor="consent-note"
                className="font-mono text-label font-medium uppercase tracking-label text-gray-600"
              >
                Where does the permission live?
              </label>
              <textarea
                id="consent-note"
                name="consentNote"
                rows={2}
                value={value.note}
                placeholder="For example: said yes over the phone, 3/2, spoke with Dana"
                aria-invalid={errors?.note ? true : undefined}
                onChange={(event) =>
                  onChange({ ...value, note: event.target.value })
                }
                className="w-full border border-outline-strong bg-surface-card px-3 py-2 font-sans text-small text-ink-900 focus:shadow-focus-ring focus:outline-none"
              />
              {errors?.note && (
                <span role="alert" className="text-small text-danger">
                  {errors.note}
                </span>
              )}
            </span>
          </span>
        )}
      </label>
    </fieldset>
  );
}
