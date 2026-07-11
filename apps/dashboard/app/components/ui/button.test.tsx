import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Button } from "./button";

describe("Button", () => {
  it("renders a real button with mono uppercase styling", () => {
    const html = renderToString(<Button>Send request</Button>);
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain("font-mono");
    expect(html).toContain("uppercase");
    expect(html).toContain("tracking-label");
    expect(html).toContain("Send request");
  });

  it("defaults to the primary ink variant", () => {
    const html = renderToString(<Button>Go</Button>);
    expect(html).toContain("bg-ink-900");
    expect(html).toContain("text-on-dark");
  });

  it.each([
    ["secondary", "border-ink-900 bg-surface-card"],
    ["ghost", "border-transparent bg-transparent"],
    ["danger", "border-red-700 bg-red-700"],
  ] as const)("renders the %s variant", (variant, classes) => {
    const html = renderToString(<Button variant={variant}>Go</Button>);
    for (const cls of classes.split(" ")) {
      expect(html).toContain(cls);
    }
  });

  it.each([
    ["sm", "text-label"],
    ["lg", "text-data"],
  ] as const)("renders the %s size", (size, cls) => {
    expect(renderToString(<Button size={size}>Go</Button>)).toContain(cls);
  });

  it("supports fullWidth and disabled", () => {
    const html = renderToString(
      <Button fullWidth disabled>
        Go
      </Button>,
    );
    expect(html).toContain("w-full");
    expect(html).toContain("disabled");
  });

  it("keeps square corners (no rounding utilities)", () => {
    expect(renderToString(<Button>Go</Button>)).not.toContain("rounded");
  });
});
