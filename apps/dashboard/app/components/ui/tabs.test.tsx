import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Tabs } from "./tabs";

const TABS = [
  { value: "all", label: "All", count: 7 },
  { value: "awaiting", label: "Awaiting reply", count: 3 },
  { value: "replied", label: "Replied" },
];

describe("Tabs", () => {
  it("renders a tablist of tabs", () => {
    const html = renderToString(<Tabs tabs={TABS} />);
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
  });

  it("selects the first tab by default with the green underline", () => {
    const html = renderToString(<Tabs tabs={TABS} />);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("border-accent-600");
  });

  it("honours defaultValue and controlled value", () => {
    const byDefault = renderToString(
      <Tabs tabs={TABS} defaultValue="replied" />,
    );
    expect(byDefault).toMatch(/aria-selected="true"[^>]*>Replied/);
    const controlled = renderToString(<Tabs tabs={TABS} value="awaiting" />);
    expect(controlled).toMatch(/aria-selected="true"[^>]*>Awaiting reply/);
  });

  it("renders mono count pills only where counts exist", () => {
    const html = renderToString(<Tabs tabs={TABS} />);
    expect(html).toContain(">7<");
    expect(html).toContain(">3<");
    expect(html.match(/tabular-nums/g)).toHaveLength(2);
  });

  it("accepts plain string tabs", () => {
    const html = renderToString(<Tabs tabs={["One", "Two"]} />);
    expect(html).toContain("One");
    expect(html).toContain("Two");
  });
});
