// @vitest-environment happy-dom
// Combobox: keyboard-complete searchable select — filter, arrows, Enter,
// Escape — with the chosen VALUE carried by a hidden input for plain
// <Form> posts.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Combobox } from "./combobox";

afterEach(cleanup);

const OPTIONS = [
  { value: "", label: "Don't import" },
  { value: "occurredAt", label: "Date", hint: "suggested" },
  { value: "rating", label: "Rating" },
  { value: "text", label: "Review text" },
];

function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <form>
      <Combobox
        name="column-0"
        ariaLabel="Field for column Date"
        options={OPTIONS}
        value={value}
        onChange={setValue}
      />
    </form>
  );
}

function hiddenValue(): string {
  const hidden = document.querySelector(
    'input[type="hidden"][name="column-0"]',
  ) as HTMLInputElement;
  return hidden.value;
}

describe("Combobox", () => {
  it("opens on focus, filters as you type, selects on Enter", async () => {
    render(<Harness />);
    const input = screen.getByRole("combobox", {
      name: "Field for column Date",
    });
    await userEvent.click(input);
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(4);

    await userEvent.keyboard("rat");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await userEvent.keyboard("{Enter}");
    expect(hiddenValue()).toBe("rating");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect((input as HTMLInputElement).value).toBe("Rating");
  });

  it("arrow keys walk the options; Escape closes without changing", async () => {
    render(<Harness initial="text" />);
    const input = screen.getByRole("combobox", {
      name: "Field for column Date",
    });
    await userEvent.click(input);
    await userEvent.keyboard("{ArrowDown}{Escape}");
    expect(hiddenValue()).toBe("text");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("clicking an option selects it; hints render in the list", async () => {
    render(<Harness />);
    await userEvent.click(
      screen.getByRole("combobox", { name: "Field for column Date" }),
    );
    expect(screen.getByText("suggested")).toBeTruthy();
    await userEvent.click(screen.getByRole("option", { name: /Date/ }));
    expect(hiddenValue()).toBe("occurredAt");
  });

  it("marks the selected option for assistive tech", async () => {
    render(<Harness initial="rating" />);
    await userEvent.click(
      screen.getByRole("combobox", { name: "Field for column Date" }),
    );
    const selected = screen
      .getAllByRole("option")
      .filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toContain("Rating");
  });
});
