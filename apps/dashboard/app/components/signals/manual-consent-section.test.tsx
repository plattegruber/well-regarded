// @vitest-environment happy-dom
// ManualConsentSection (#138): defaults to "No / Not asked", the
// attestation reveals channel checkboxes + the required note, both
// consequences are plain language, and roles without manage_consent get a
// disabled attestation option — never a hidden one.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ManualConsent } from "@wellregarded/core";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualConsentSection } from "./manual-consent-section";

afterEach(cleanup);

function Harness({
  canAttest = true,
  initial = { choice: "unknown" } as ManualConsent,
  onChange = () => {},
}: {
  canAttest?: boolean;
  initial?: ManualConsent;
  onChange?: (value: ManualConsent) => void;
}) {
  const [value, setValue] = useState<ManualConsent>(initial);
  return (
    <ManualConsentSection
      value={value}
      canAttest={canAttest}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe("ManualConsentSection", () => {
  it('defaults to "No / Not asked" with no attestation details visible', () => {
    render(<Harness />);
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios[0]?.checked).toBe(true);
    expect(screen.queryByTestId("attest-details")).toBeNull();
    expect(
      screen.getByText(/private insights only.*never be published/i),
    ).toBeTruthy();
  });

  it("choosing the attestation reveals channels and the required note", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("radio", { name: /practice attests/i }));

    expect(screen.getByTestId("attest-details")).toBeTruthy();
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    // The channel vocabulary from Epic #3's consents scopes.
    expect(checkboxes.map((c) => c.value).sort()).toEqual([
      "email",
      "gbp",
      "in_office",
      "website",
    ]);
    // The section nests inside the option's <label>, so query the textarea
    // directly rather than by (ambiguous) label association.
    expect(
      screen.getByPlaceholderText(/said yes over the phone/i),
    ).toBeTruthy();
  });

  it("channel toggles round-trip through onChange", async () => {
    const user = userEvent.setup();
    const changes: ManualConsent[] = [];
    render(<Harness onChange={(value) => changes.push(value)} />);
    await user.click(screen.getByRole("radio", { name: /practice attests/i }));
    await user.click(screen.getByRole("checkbox", { name: "Website" }));
    await user.click(screen.getByRole("checkbox", { name: "Google profile" }));

    const last = changes[changes.length - 1];
    expect(last).toMatchObject({
      choice: "practice_attested",
      channels: ["website", "gbp"],
    });

    await user.click(screen.getByRole("checkbox", { name: "Website" }));
    expect(changes[changes.length - 1]).toMatchObject({ channels: ["gbp"] });
  });

  it("switching back to not-asked hides the details again", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("radio", { name: /practice attests/i }));
    expect(screen.getByTestId("attest-details")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /no \/ not asked/i }));
    expect(screen.queryByTestId("attest-details")).toBeNull();
  });

  it("without manage_consent the attestation is disabled and says why", () => {
    render(<Harness canAttest={false} />);
    const attest = screen.getByRole("radio", {
      name: /practice attests/i,
    }) as HTMLInputElement;
    expect(attest.disabled).toBe(true);
    expect(screen.getByText(/your role can't record consent/i)).toBeTruthy();
  });

  it("renders channel and note errors when provided", () => {
    const spy = vi.fn();
    render(
      <ManualConsentSection
        value={{ choice: "practice_attested", channels: [], note: "" }}
        canAttest
        onChange={spy}
        errors={{
          channels: "Pick at least one place the permission covers.",
          note: "Say where the permission lives (who said yes, when, to whom).",
        }}
      />,
    );
    expect(
      screen.getByText("Pick at least one place the permission covers."),
    ).toBeTruthy();
    expect(screen.getByText(/say where the permission lives/i)).toBeTruthy();
  });
});
