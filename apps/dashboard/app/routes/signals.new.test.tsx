// @vitest-environment happy-dom
// Add signal (#138): the form renders its required fields with today's
// date prefilled, suggestion chips fill the source description, consent
// appears once there is text, no visibility toggle exists, and
// `buildManualPayload` shapes the API body (trim, lowercase email, omit
// empties).
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import NewSignal, { buildManualPayload } from "./signals.new";

afterEach(cleanup);

function loaderData(overrides: { canAttest?: boolean } = {}) {
  return {
    apiUrl: "http://localhost:8787",
    canAttest: overrides.canAttest ?? true,
    locations: [
      { id: "0f9619ff-8b86-4d01-b42d-00cf4fc964ff", name: "Main Street" },
    ],
    providers: [
      { id: "1f9619ff-8b86-4d01-b42d-00cf4fc964ff", name: "Dr. Patel" },
    ],
    today: "2026-07-10",
  };
}

function renderForm(data = loaderData()) {
  const NewSignalAny = NewSignal as (props: {
    loaderData: unknown;
  }) => React.ReactNode;
  const Stub = createRoutesStub([
    {
      path: "/signals/new",
      Component: () => <NewSignalAny loaderData={data} />,
    },
  ]);
  return render(<Stub initialEntries={["/signals/new"]} />);
}

describe("Add signal form", () => {
  it("renders text, date (defaulting today, capped at today), and source description", () => {
    renderForm();
    expect(screen.getByLabelText(/the feedback/i)).toBeTruthy();
    const date = screen.getByLabelText(/when it happened/i) as HTMLInputElement;
    expect(date.value).toBe("2026-07-10");
    expect(date.max).toBe("2026-07-10");
    expect(screen.getByLabelText(/where it came from/i)).toBeTruthy();
  });

  it("has NO visibility toggle — manual entries are private at M1", () => {
    renderForm();
    expect(screen.queryByText(/visibility/i)).toBeNull();
    expect(screen.queryByRole("radio", { name: /public/i })).toBeNull();
  });

  it("suggestion chips fill the source description verbatim", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole("button", { name: "phone call" }));
    const input = screen.getByLabelText(
      /where it came from/i,
    ) as HTMLInputElement;
    expect(input.value).toBe("phone call");
  });

  it("reveals the consent section once feedback text is present", async () => {
    const user = userEvent.setup();
    renderForm();
    expect(screen.queryByTestId("manual-consent")).toBeNull();
    await user.type(screen.getByLabelText(/the feedback/i), "Lovely visit.");
    expect(screen.getByTestId("manual-consent")).toBeTruthy();
  });

  it("client-validates before submitting (missing source description)", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText(/the feedback/i), "Lovely visit.");
    await user.click(screen.getByRole("button", { name: /add signal/i }));
    expect(screen.getByText(/say where this came from/i)).toBeTruthy();
  });
});

describe("buildManualPayload", () => {
  const base = {
    text: "  Lovely visit.  ",
    occurredOn: "2026-07-10",
    sourceDescription: " phone call ",
    locationId: "",
    providerId: "",
    patientName: "",
    patientEmail: "",
    patientPhone: "",
    consent: { choice: "unknown" as const },
  };

  it("trims text/source and omits empty optionals", () => {
    expect(buildManualPayload(base)).toEqual({
      text: "Lovely visit.",
      occurredOn: "2026-07-10",
      sourceDescription: "phone call",
      consent: { choice: "unknown" },
    });
  });

  it("lowercases the email and includes only the patient fields given", () => {
    const payload = buildManualPayload({
      ...base,
      patientEmail: " Rosa.Alvarez@Example.COM ",
    });
    expect(payload.patient).toEqual({ email: "rosa.alvarez@example.com" });
  });

  it("carries structured choices and attested consent through", () => {
    const payload = buildManualPayload({
      ...base,
      locationId: "0f9619ff-8b86-4d01-b42d-00cf4fc964ff",
      providerId: "1f9619ff-8b86-4d01-b42d-00cf4fc964ff",
      patientName: "Rosa",
      consent: {
        choice: "practice_attested",
        channels: ["website"],
        note: "  said yes on the phone  ",
      },
    });
    expect(payload.locationId).toBe("0f9619ff-8b86-4d01-b42d-00cf4fc964ff");
    expect(payload.providerId).toBe("1f9619ff-8b86-4d01-b42d-00cf4fc964ff");
    expect(payload.patient).toEqual({ name: "Rosa" });
    expect(payload.consent).toEqual({
      choice: "practice_attested",
      channels: ["website"],
      note: "said yes on the phone",
    });
  });
});
