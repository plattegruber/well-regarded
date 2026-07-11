// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, Form } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { Field } from "./field";

afterEach(cleanup);

describe("Field", () => {
  it("renders the error for its name from explicit fieldErrors, with aria wiring", () => {
    render(
      createRoutesStubField({
        errors: { email: ["Enter a full address."], other: ["Not mine."] },
      }),
    );
    const input = screen.getByLabelText("Email");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy as string);
    expect(description?.textContent).toBe("Enter a full address.");
    expect(screen.queryByText("Not mine.")).toBeNull();
  });

  it("renders clean without errors", () => {
    render(createRoutesStubField({}));
    const input = screen.getByLabelText("Email");
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("reads useActionData().fieldErrors by default (plain <Form> path)", async () => {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <Form method="post">
            <Field name="email" label="Email" defaultValue="nope" />
            <button type="submit">Save</button>
          </Form>
        ),
        action: () => ({
          fieldErrors: { email: ["Enter a full address."] },
        }),
      },
    ]);
    render(<Stub initialEntries={["/"]} />);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter a full address.")).toBeTruthy();
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe(
      "true",
    );
  });
});

function createRoutesStubField({
  errors,
}: {
  errors?: Record<string, string[]>;
}) {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => <Field name="email" label="Email" errors={errors} />,
    },
  ]);
  return <Stub initialEntries={["/"]} />;
}
