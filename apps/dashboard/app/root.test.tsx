// Root ErrorBoundary (#141): designed 404 with the way home, calm generic
// errors, stack only in dev. The fabricated route-error objects match
// react-router's isRouteErrorResponse duck test (status + statusText +
// data).
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ErrorBoundary } from "./root";

// biome-ignore lint/suspicious/noExplicitAny: the boundary only reads `error`; the generated props type wants the full route context
const boundary = (error: unknown) => (ErrorBoundary as any)({ error });

function render(error: unknown): string {
  return renderToString(boundary(error));
}

function routeError(status: number, statusText = "") {
  return { status, statusText, data: null, internal: true };
}

describe("root ErrorBoundary", () => {
  it("renders the designed 404 with a link back to /today", () => {
    const html = render(routeError(404, "Not Found"));
    expect(html).toContain("HTTP 404");
    expect(html).toContain("This page doesn&#x27;t exist");
    expect(html).toContain(
      "The address may be mistyped, or the page may have moved.",
    );
    expect(html).toContain('href="/today"');
    expect(html).toContain("Go to today");
  });

  it("renders status and message for other route errors", () => {
    const html = render(routeError(403, "Forbidden"));
    expect(html).toContain("HTTP 403");
    expect(html).toContain("Something went wrong");
    expect(html).toContain("Forbidden");
  });

  it("apologizes calmly for unexpected errors and shows the dev stack", () => {
    const error = new Error("boom at line 12");
    const html = render(error);
    expect(html).toContain("Something went wrong");
    // Vitest runs with import.meta.env.DEV = true, so the stack renders.
    expect(html).toContain("boom at line 12");
    expect(html).toContain("<pre");
  });

  it("keeps the voice: no exclamation points anywhere", () => {
    for (const error of [routeError(404), routeError(500), new Error("x")]) {
      const text = render(error).replace(/<[^>]+>/g, " ");
      expect(text).not.toContain("!");
    }
  });
});
