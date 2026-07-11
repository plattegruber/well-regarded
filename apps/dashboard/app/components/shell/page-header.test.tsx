import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Overline, PageHeader } from "./page-header";

describe("PageHeader", () => {
  it("renders overline, h1 title, description and action", () => {
    const html = renderToString(
      <PageHeader
        overline="Thursday, July 10"
        title="Good morning"
        description="Here is what needs you, and what does not."
        action={<button type="button">Send request</button>}
      />,
    );
    expect(html).toContain('data-testid="page-header"');
    expect(html).toMatch(/<h1[^>]*>Good morning<\/h1>/);
    expect(html).toContain("Thursday, July 10");
    expect(html).toContain("Here is what needs you, and what does not.");
    expect(html).toContain("Send request");
  });

  it("sets the title in display type at -3% tracking", () => {
    const html = renderToString(<PageHeader title="Signals" />);
    expect(html).toContain("font-display");
    expect(html).toContain("tracking-display");
    expect(html).toContain("text-h1");
  });
});

describe("Overline", () => {
  it("is an 11px mono uppercase micro-label", () => {
    const html = renderToString(<Overline>Design system</Overline>);
    expect(html).toContain("font-mono");
    expect(html).toContain("text-label");
    expect(html).toContain("uppercase");
    expect(html).toContain("tracking-label");
  });
});
