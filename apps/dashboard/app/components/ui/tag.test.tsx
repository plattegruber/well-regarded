import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Tag } from "./tag";

describe("Tag", () => {
  it("renders a static tag as an ink-outlined mono span", () => {
    const html = renderToString(<Tag>Dental anxiety</Tag>);
    expect(html).toContain("<span");
    expect(html).toContain("border-outline-strong");
    expect(html).toContain("font-mono");
  });

  it("inverts to ink when selected", () => {
    const html = renderToString(<Tag selected>All sources</Tag>);
    expect(html).toContain("bg-ink-900");
    expect(html).toContain("text-on-dark");
  });

  it("renders clickable filter chips as buttons", () => {
    const html = renderToString(<Tag onClick={() => {}}>Google</Tag>);
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
  });

  it("exposes a labelled remove control", () => {
    const html = renderToString(<Tag onRemove={() => {}}>Wait time</Tag>);
    expect(html).toContain('aria-label="Remove"');
  });
});
