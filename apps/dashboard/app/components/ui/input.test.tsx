import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Input } from "./input";

describe("Input", () => {
  it("associates the mono overline label with the field", () => {
    const html = renderToString(<Input label="Practice name" />);
    const forId = html.match(/for="([^"]+)"/)?.[1];
    expect(forId).toBeTruthy();
    expect(html).toContain(`id="${forId}"`);
    expect(html).toContain("uppercase");
    expect(html).toContain("Practice name");
  });

  it("is outlined in ink by default", () => {
    expect(renderToString(<Input />)).toContain("border-outline-strong");
  });

  it("describes errors and flags the field invalid", () => {
    const html = renderToString(
      <Input label="Location" error="A location name is required." />,
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("border-status-negative");
    expect(html).toContain("A location name is required.");
    const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
  });

  it("renders a hint when there is no error", () => {
    const html = renderToString(<Input hint="Optional." />);
    expect(html).toContain("Optional.");
    expect(html).not.toContain("aria-invalid");
  });
});
