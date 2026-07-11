import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Badge } from "./badge";

describe("Badge", () => {
  it("renders a mono uppercase micro-label, neutral by default", () => {
    const html = renderToString(<Badge>Profile</Badge>);
    expect(html).toContain("font-mono");
    expect(html).toContain("uppercase");
    expect(html).toContain("bg-gray-100");
    expect(html).toContain("text-gray-600");
    expect(html).toContain("Profile");
  });

  it.each([
    ["brand", "bg-ink-900"],
    ["positive", "bg-status-positive-bg"],
    ["caution", "bg-status-caution-bg"],
    ["negative", "bg-status-negative-bg"],
    ["gold", "bg-accent-100"],
  ] as const)("renders the %s tone", (tone, cls) => {
    expect(renderToString(<Badge tone={tone}>Urgent</Badge>)).toContain(cls);
  });
});
