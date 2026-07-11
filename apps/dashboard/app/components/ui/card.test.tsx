import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Card } from "./card";

describe("Card", () => {
  it("is a flat hairline-bordered surface", () => {
    const html = renderToString(<Card>Body</Card>);
    expect(html).toContain("border-hairline");
    expect(html).toContain("bg-surface-card");
    expect(html).not.toContain("shadow");
    expect(html).not.toContain("rounded");
  });

  it("renders title and action in the header row", () => {
    const html = renderToString(
      <Card
        title="Needs your attention"
        action={<button type="button">See all</button>}
      >
        Body
      </Card>,
    );
    expect(html).toMatch(/<h3[^>]*>Needs your attention<\/h3>/);
    expect(html).toContain("See all");
  });

  it("sinks onto the gray ground when sunken", () => {
    expect(renderToString(<Card sunken>Body</Card>)).toContain(
      "bg-surface-sunken",
    );
  });

  it("accepts a padding override", () => {
    expect(renderToString(<Card padding="24px">Body</Card>)).toContain(
      "padding:24px",
    );
  });
});
