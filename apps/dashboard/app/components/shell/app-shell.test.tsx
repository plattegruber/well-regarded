import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { AppShell } from "./app-shell";

function render(path = "/") {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <AppShell>
        <p>Content</p>
      </AppShell>
    </MemoryRouter>,
  );
}

describe("AppShell", () => {
  it("renders the sidebar with the plain-type wordmark", () => {
    const html = render();
    expect(html).toContain('data-testid="app-sidebar"');
    expect(html).toContain("Well Regarded");
    // The DS forbids a logo mark: the wordmark is type only.
    expect(html).not.toContain("<img");
  });

  it("links the eight surfaces plus settings, in the mockup order", () => {
    const html = render();
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([
      "/today",
      "/signals",
      "/reviews",
      "/recovery",
      "/proof",
      "/coverage",
      "/insights",
      "/presence",
      "/settings",
    ]);
    for (const label of [
      "Today",
      "Signals",
      "Reviews",
      "Recovery",
      "Patient proof",
      "Trust coverage",
      "Insights",
      "Presence",
      "Settings",
    ]) {
      expect(html).toContain(`<span>${label}</span>`);
    }
  });

  it("marks the current surface active in green-on-accent-50", () => {
    const html = render("/reviews");
    expect(html).toContain('aria-current="page"');
    const active = html.match(/<a[^>]*aria-current="page"[^>]*>/)?.[0];
    expect(active).toContain("/reviews");
    expect(active).toContain("bg-accent-50");
    expect(active).toContain("text-accent-700");
  });

  it("carries badge slots on queue-like surfaces", () => {
    const html = render();
    expect(html).toContain("bg-red-100");
    expect(html).toContain("text-red-700");
  });

  it("renders the practice footer block", () => {
    const html = render();
    expect(html).toContain("Cedar Ridge Dental");
    expect(html).toContain('aria-label="4.8 of 5 stars"');
    expect(html).toContain("214 reviews · 2 locations");
  });

  it("renders children in the constrained content column", () => {
    const html = render();
    expect(html).toContain("max-w-280");
    expect(html).toContain("<p>Content</p>");
  });
});
