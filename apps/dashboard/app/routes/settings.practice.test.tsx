// @vitest-environment happy-dom
// Integration-style render tests for the reference CRUD page (#141),
// through a routes stub with the real loader and action. The pure
// loader/action unit tests live in settings.practice.action.test.ts (node
// environment — server code never sees the DOM shims).
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetPracticeStore } from "~/lib/practice-store.server";
import PracticeProfile, { action, loader } from "./settings.practice";

beforeEach(resetPracticeStore);
afterEach(cleanup);

describe("practice profile page", () => {
  function renderPage() {
    const Stub = createRoutesStub(
      [
        {
          path: "/settings/practice",
          // biome-ignore lint/suspicious/noExplicitAny: the stub's own props satisfy the generated route props at runtime
          Component: PracticeProfile as any,
          HydrateFallback: () => null,
          loader,
          action,
        },
      ],
      // The stub's AppLoadContext — the action reads cloudflare.env.
      {
        cloudflare: {
          env: { ENVIRONMENT: "local" } as Env,
          ctx: {} as ExecutionContext,
        },
        // biome-ignore lint/suspicious/noExplicitAny: partial context is enough here
      } as any,
    );
    return render(<Stub initialEntries={["/settings/practice"]} />);
  }

  it("renders the current values from the loader", async () => {
    renderPage();
    expect(await screen.findByDisplayValue("Cedar Ridge Dental")).toBeTruthy();
    expect(screen.getByDisplayValue("(555) 201-4400")).toBeTruthy();
    expect(
      screen.getByDisplayValue("https://cedarridgedental.example"),
    ).toBeTruthy();
    expect(screen.getByLabelText("Time zone")).toBeTruthy();
  });

  it("shows the field error inline after submitting an invalid URL", async () => {
    renderPage();
    const website = await screen.findByLabelText("Website");
    await userEvent.clear(website);
    await userEvent.type(website, "not-a-url");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText("Enter a full URL, like https://example.com."),
    ).toBeTruthy();
    expect(website.getAttribute("aria-invalid")).toBe("true");
  });
});
