// @vitest-environment happy-dom
// The reclassification affordances (#93): the ✓/✗ "was this right?"
// micro-buttons on inferred judgments, the correction picker, and the
// association confirm/correct — all hidden entirely for viewers who lack
// reclassify_signal (never rendered disabled).

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import {
  AssociationRow,
  type AssociationRowData,
  DerivationRow,
  type DerivationRowData,
} from "./reclassify-controls";

afterEach(cleanup);

const inferredRow: DerivationRowData = {
  dimension: "sentiment",
  label: "Sentiment",
  value: "Negative",
  rawValue: "negative",
  basis: "inferred_text",
  confidence: 0.82,
  rationale: null,
  judgedOn: "July 4, 2026",
};

const manualRow: DerivationRowData = {
  ...inferredRow,
  basis: "manual",
  confidence: 1,
};

const unclassifiedRow: DerivationRowData = {
  dimension: "urgency",
  label: "Urgency",
  value: null,
  rawValue: null,
  basis: null,
  confidence: null,
  rationale: null,
  judgedOn: null,
};

function renderRow(row: DerivationRowData, canReclassify: boolean) {
  const Stub = createRoutesStub([
    {
      path: "/signals/abc",
      Component: () => (
        <DerivationRow row={row} canReclassify={canReclassify} />
      ),
      action: () => null,
    },
  ]);
  return render(<Stub initialEntries={["/signals/abc"]} />);
}

describe("DerivationRow", () => {
  it("offers ✓/✗ on inferred judgments — the one-interaction confirm", async () => {
    renderRow(inferredRow, true);
    const confirm = screen.getByRole("button", { name: "Confirm sentiment" });
    // ✓ is a direct submit (no dialog): it lives inside a form with the
    // confirm intent for this dimension.
    const form = confirm.closest("form");
    if (!form) throw new Error("expected the ✓ inside a form");
    expect(form.querySelector('input[name="intent"]')).toHaveProperty(
      "value",
      "confirm-derivation",
    );
    expect(form.querySelector('input[name="dimension"]')).toHaveProperty(
      "value",
      "sentiment",
    );
    expect(
      screen.getByRole("button", { name: "Correct sentiment" }),
    ).toBeDefined();
  });

  it("✗ opens the correction picker pre-focused on the dimension's vocabulary", async () => {
    const user = userEvent.setup();
    renderRow(inferredRow, true);
    await user.click(screen.getByRole("button", { name: "Correct sentiment" }));
    const select = screen.getByLabelText(
      "Sentiment value",
    ) as unknown as HTMLSelectElement;
    expect(select.value).toBe("negative");
    const options = Array.from(select.options).map((option) => option.value);
    expect(options).toEqual(["positive", "mixed", "negative"]);
    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
  });

  it("staff-confirmed judgments get a quiet Correct affordance, not ✓/✗", () => {
    renderRow(manualRow, true);
    expect(screen.queryByTitle("Was this right? Confirm")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Correct sentiment" }),
    ).toBeDefined();
  });

  it("unclassified dimensions can be classified manually", async () => {
    const user = userEvent.setup();
    renderRow(unclassifiedRow, true);
    await user.click(screen.getByRole("button", { name: "Classify urgency" }));
    const select = screen.getByLabelText(
      "Urgency value",
    ) as unknown as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "critical",
    ]);
  });

  it("hides every affordance without the permission", () => {
    renderRow(inferredRow, false);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Negative")).toBeDefined();
  });
});

const hintRow: AssociationRowData = {
  kind: "provider",
  label: "Provider",
  name: null,
  hint: { text: "Dr. Patel", basis: "inferred_text" },
  options: [
    { id: "11111111-1111-4111-8111-111111111111", name: "Dr. Patel" },
    { id: "22222222-2222-4222-8222-222222222222", name: "Dr. Okafor" },
  ],
};

function renderAssociation(row: AssociationRowData, canReclassify: boolean) {
  const Stub = createRoutesStub([
    {
      path: "/signals/abc",
      Component: () => (
        <AssociationRow row={row} canReclassify={canReclassify} />
      ),
      action: () => null,
    },
  ]);
  return render(<Stub initialEntries={["/signals/abc"]} />);
}

describe("AssociationRow", () => {
  it("shows an unresolved hint with its inferred badge and a confirm affordance", async () => {
    const user = userEvent.setup();
    renderAssociation(hintRow, true);
    expect(screen.getByText("“Dr. Patel”")).toBeDefined();
    expect(screen.getByTestId("association-hint-provider")).toBeDefined();

    // "Yes, this is Dr. Patel": the picker pre-selects the name match.
    await user.click(screen.getByRole("button", { name: "Confirm provider" }));
    const select = screen.getByLabelText(
      "Provider association",
    ) as unknown as HTMLSelectElement;
    expect(select.value).toBe("11111111-1111-4111-8111-111111111111");
    // "None / unknown" is always offered.
    expect(Array.from(select.options)[0]?.text).toBe("None / unknown");
  });

  it("renders a staff-confirmed association with the confirmed badge", () => {
    renderAssociation(
      {
        ...hintRow,
        name: "Dr. Patel",
        hint: { text: "Dr. Patel", basis: "manual" },
      },
      true,
    );
    expect(screen.getByText("Staff confirmed")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Change provider" }),
    ).toBeDefined();
  });

  it("renders 'Not linked' quietly and hides affordances without permission", () => {
    renderAssociation({ ...hintRow, hint: null }, false);
    expect(screen.getByText("Not linked")).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
