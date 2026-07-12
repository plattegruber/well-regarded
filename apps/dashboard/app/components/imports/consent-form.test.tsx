// @vitest-environment happy-dom
// ConsentForm (#134 step 3): no default selection, the attestation note is
// required for practice_attested, and both consequences are stated.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { ConsentForm, type ConsentFormProps } from "./consent-form";

afterEach(cleanup);

function renderForm(props: Partial<ConsentFormProps> = {}) {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ConsentForm defaultChoice={null} defaultNote={null} {...props} />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("ConsentForm", () => {
  it("starts with NO selection — the office manager must choose", () => {
    renderForm();
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    for (const radio of radios) {
      expect(radio.checked).toBe(false);
      // Native required blocks submission client-side; the action re-checks.
      expect(radio.required).toBe(true);
    }
  });

  it("states the publishability consequence under each option", () => {
    renderForm();
    expect(
      screen.getByText("These can be suggested for publishing after review."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /private insights only.*never be published unless the patient grants permission later/i,
      ),
    ).toBeTruthy();
  });

  it("choosing practice_attested reveals the required attestation note", async () => {
    renderForm();
    expect(
      screen.queryByLabelText("Where does the permission live?"),
    ).toBeNull();

    await userEvent.click(
      screen.getByRole("radio", { name: /We have documented permission/ }),
    );
    const note = screen.getByLabelText(
      "Where does the permission live?",
    ) as HTMLTextAreaElement;
    expect(note.required).toBe(true);
    expect(note.name).toBe("attestationNote");
  });

  it("renders the action's field errors for choice and note", () => {
    renderForm({
      defaultChoice: "practice_attested",
      fieldErrors: {
        consentChoice: ["Choose one."],
        attestationNote: ["Note where the permission lives."],
      },
    });
    const alerts = screen.getAllByRole("alert").map((el) => el.textContent);
    expect(alerts).toContain("Choose one.");
    expect(alerts).toContain("Note where the permission lives.");
  });

  it("resumes a saved choice and note", () => {
    renderForm({
      defaultChoice: "practice_attested",
      defaultNote: "Signed intake forms 2021–2024",
    });
    const attested = screen.getByRole("radio", {
      name: /We have documented permission/,
    }) as HTMLInputElement;
    expect(attested.checked).toBe(true);
    expect(
      (
        screen.getByLabelText(
          "Where does the permission live?",
        ) as HTMLTextAreaElement
      ).defaultValue,
    ).toBe("Signed intake forms 2021–2024");
  });
});
