// @vitest-environment happy-dom
// MappingForm (#134): suggestion prefill, the suggested-but-unreviewed
// nudge, ambiguity forcing an explicit date choice, and error display.

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ColumnDetection } from "@wellregarded/core";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { MappingForm, type MappingFormProps } from "./mapping-form";

afterEach(cleanup);

const HEADERS = ["Date", "Stars", "Review", "Source"];
const PREVIEW_ROWS = [
  ["01/02/2024", "5", "Great cleaning", "Google"],
  ["03/04/2024", "4", "Kind staff", "Google"],
];
const DETECTED: ColumnDetection[] = [
  {
    index: 0,
    header: "Date",
    suggestedTarget: "occurredAt",
    dateFormat: { ambiguous: ["MM/DD/YYYY", "DD/MM/YYYY"] },
  },
  { index: 1, header: "Stars", suggestedTarget: "rating", ratingScale: 5 },
  { index: 2, header: "Review", suggestedTarget: "text" },
  { index: 3, header: "Source", suggestedTarget: null },
];

function renderForm(props: Partial<MappingFormProps> = {}) {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <MappingForm
          headers={HEADERS}
          previewRows={PREVIEW_ROWS}
          detected={DETECTED}
          savedMapping={null}
          {...props}
        />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("MappingForm", () => {
  it("prefills a combobox per column from the suggestions", () => {
    renderForm();
    expect(
      screen.getByRole("combobox", { name: "Field for column Date" }),
    ).toHaveProperty("value", "Date");
    expect(
      screen.getByRole("combobox", { name: "Field for column Stars" }),
    ).toHaveProperty("value", "Rating");
    expect(
      screen.getByRole("combobox", { name: "Field for column Review" }),
    ).toHaveProperty("value", "Review text");
    // Unmatched → the explicit, visible "Don't import" default.
    expect(
      screen.getByRole("combobox", { name: "Field for column Source" }),
    ).toHaveProperty("value", "Don't import");
  });

  it("tags unreviewed suggestions and clears them via 'These look right'", async () => {
    renderForm();
    // Date, Stars, Review arrived as suggestions.
    expect(screen.getAllByText("suggested")).toHaveLength(3);
    await userEvent.click(
      screen.getByRole("button", { name: "These look right" }),
    );
    expect(screen.queryAllByText("suggested")).toHaveLength(0);
  });

  it("ambiguous dates force an explicit choice: radios, no default, sample rows both ways", () => {
    renderForm();
    const group = screen.getByRole("group", {
      name: "Which way do these dates read?",
    });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    for (const radio of radios) {
      expect((radio as HTMLInputElement).checked).toBe(false);
    }
    // The same sample value, read both ways.
    expect(
      within(group).getByText("01/02/2024 → January 2, 2024"),
    ).toBeTruthy();
    expect(
      within(group).getByText("01/02/2024 → February 1, 2024"),
    ).toBeTruthy();
  });

  it("a source/platform column gets the informational badge, not a suggestion", () => {
    renderForm();
    expect(screen.getByText("source — one per file")).toBeTruthy();
  });

  it("renders per-field and form-level errors from the action", () => {
    renderForm({
      fieldErrors: {
        "": ["Map a column to date — every entry needs a when."],
        "dateFormat-0": ["Choose how these dates should be read."],
      },
    });
    const alerts = screen.getAllByRole("alert").map((el) => el.textContent);
    expect(alerts).toContain(
      "Map a column to date — every entry needs a when.",
    );
    expect(alerts).toContain("Choose how these dates should be read.");
  });

  it("resuming a saved mapping shows the saved choices, not the suggestions", () => {
    renderForm({
      savedMapping: {
        occurredAt: { column: "Date", dateFormat: "DD/MM/YYYY" },
        text: { column: "Review" },
        visibility: { constant: "public" },
      },
    });
    // Stars was deliberately left out — no resurrected suggestion, no tag.
    expect(
      screen.getByRole("combobox", { name: "Field for column Stars" }),
    ).toHaveProperty("value", "Don't import");
    expect(screen.queryAllByText("suggested")).toHaveLength(0);
    // The saved (ambiguous) format arrives selected.
    const group = screen.getByRole("group", {
      name: "Which way do these dates read?",
    });
    const checked = within(group)
      .getAllByRole("radio")
      .filter((radio) => (radio as HTMLInputElement).checked);
    expect(checked).toHaveLength(1);
    expect((checked[0] as HTMLInputElement).value).toBe("DD/MM/YYYY");
    // Saved visibility constant prefills the file-level radio.
    const publicRadio = screen.getByRole("radio", {
      name: /Public reviews/,
    }) as HTMLInputElement;
    expect(publicRadio.checked).toBe(true);
  });

  it("the file-level visibility choice starts unanswered for a fresh draft", () => {
    renderForm();
    const radios = screen
      .getAllByRole("radio")
      .filter((r) => (r as HTMLInputElement).name === "visibility");
    expect(radios).toHaveLength(2);
    for (const radio of radios) {
      expect((radio as HTMLInputElement).checked).toBe(false);
    }
  });
});
