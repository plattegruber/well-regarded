// The visibility badge must make public vs private impossible to misread
// (#88 requirement 5) — the private treatment is deliberately louder.
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { VisibilityBadge } from "./visibility-badge";

describe("VisibilityBadge", () => {
  it("renders public as a quiet outlined chip, no lock", () => {
    const html = renderToString(<VisibilityBadge visibility="public" />);
    expect(html).toContain('data-visibility="public"');
    expect(html).toContain("public");
    expect(html).toContain("border-accent-700");
    expect(html).not.toContain("<svg");
  });

  it("renders private filled amber with a lock icon", () => {
    const html = renderToString(<VisibilityBadge visibility="private" />);
    expect(html).toContain('data-visibility="private"');
    expect(html).toContain("private");
    expect(html).toContain("bg-amber-100");
    expect(html).toContain("<svg");
  });
});
