// @vitest-environment happy-dom
// WizardStepper (#134): the current step is announced via aria-current;
// reached steps link back, future steps stay inert.
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { WizardStepper } from "./stepper";

afterEach(cleanup);

const DRAFT_ID = "0f9619ff-8b86-4d01-b42d-00cf4fc964ff";

function renderStepper(
  current: "map" | "validate" | "consent" | "confirm",
  reached = current,
) {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <WizardStepper draftId={DRAFT_ID} current={current} reached={reached} />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("WizardStepper", () => {
  it("marks the current step with aria-current=step", () => {
    renderStepper("validate", "consent");
    const nav = screen.getByRole("navigation", { name: "Import steps" });
    const current = nav.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain("Check rows");
  });

  it("reached steps are links; future steps are not", () => {
    renderStepper("validate", "validate");
    const links = screen.getAllByRole("link").map((a) => a.textContent);
    expect(links.join(" ")).toContain("Map columns");
    // consent and confirm are ahead of `reached` — inert text, no link.
    expect(links.join(" ")).not.toContain("Consent");
    expect(links.join(" ")).not.toContain("Confirm");
    expect(
      screen.getByRole("link", { name: /Map columns/ }).getAttribute("href"),
    ).toBe(`/settings/imports/${DRAFT_ID}/map`);
  });
});
