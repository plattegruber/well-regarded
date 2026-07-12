// @vitest-environment happy-dom
//
// Interaction tests for the composer (#79 + #83's picker): the client-side
// deterministic layer blocks submission as you type, warn demands the
// acknowledgment, the degraded notice renders honestly, AI drafts arrive
// editable (never auto-submitted), and template insertion interpolates
// placeholders behind the overwrite confirm. The route action is stubbed
// per intent — its real behavior is covered by the action tests.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

import { textHash } from "~/lib/safety-spans";

import {
  ResponseComposer,
  type ResponseComposerProps,
} from "./response-composer";

const ACTION = "/reviews/8b0d3f8e-0000-4000-8000-000000000000/responses";
const RESPONSE_ID = "9c1d2e3f-0000-4000-8000-000000000001";

const TEMPLATES = [
  {
    id: "11111111-0000-4000-8000-000000000001",
    name: "Positive review",
    tone: "warm",
    body: "Thank you so much for the kind words, {reviewer_name}. It means a lot to us at {practice_name}.",
  },
];

/** Stub the responses action per intent; tests override cases they need. */
type ActionStub = (fields: Record<string, string>) => unknown;

function setup(
  props: Partial<ResponseComposerProps> = {},
  actionStub: ActionStub = () => ({}),
) {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ResponseComposer
          action={ACTION}
          draft={null}
          templates={TEMPLATES}
          reviewerName={null}
          practiceName="Cedar Ridge Dental"
          debounceMs={10}
          autosaveMs={10_000}
          {...props}
        />
      ),
    },
    {
      path: ACTION,
      action: async ({ request }) => {
        const fields = Object.fromEntries(
          (await request.formData()).entries(),
        ) as Record<string, string>;
        return actionStub(fields);
      },
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

function body(): HTMLTextAreaElement {
  return screen.getByTestId("composer-body") as HTMLTextAreaElement;
}

function submitButton(): HTMLButtonElement {
  return screen.getByTestId("submit-for-approval") as HTMLButtonElement;
}

describe("ResponseComposer", () => {
  it("blocks submission the moment a date is typed — client-side, no server", async () => {
    const user = userEvent.setup();
    setup();

    await user.type(body(), "So sorry about March 3rd.");

    // The deterministic layer fires per keystroke: red span in the
    // overlay, disabled submit, and the plain-language explanation.
    const overlay = screen.getByTestId("safety-highlight-overlay");
    const mark = within(overlay).getByText("March 3rd");
    expect(mark.tagName).toBe("MARK");
    expect(mark.getAttribute("data-level")).toBe("block");

    expect(submitButton().disabled).toBe(true);
    expect(screen.getByTestId("block-explanation").textContent).toContain(
      "can't be submitted",
    );
    expect(screen.getByTestId("safety-findings").textContent).toContain(
      "Names a specific date",
    );
    expect(body().getAttribute("aria-invalid")).toBe("true");

    // Editing the date away re-enables submission.
    await user.clear(body());
    await user.type(body(), "So sorry to hear this.");
    expect(submitButton().disabled).toBe(false);
    expect(screen.queryByTestId("block-explanation")).toBeNull();
  });

  it("warn-level findings require the acknowledgment tick before submit", async () => {
    const user = userEvent.setup();
    setup();

    await user.type(body(), "Call us at 555-201-4400 anytime.");

    // A phone number is a deterministic warn: amber, not blocking — but
    // the same acknowledgment the approve side demands appears here first.
    expect(screen.queryByTestId("block-explanation")).toBeNull();
    const checkbox = screen.getByTestId(
      "acknowledge-warnings",
    ) as HTMLInputElement;
    expect(submitButton().disabled).toBe(true);

    await user.click(checkbox);
    expect(submitButton().disabled).toBe(false);
  });

  it("renders the honest degraded notice when the AI layer was skipped", async () => {
    const text = "A perfectly safe reply.";
    setup({}, (fields) => {
      if (fields.intent !== "safety-check") return {};
      return {
        safety: {
          level: "ok",
          checkedHash: textHash(fields.body ?? ""),
          findings: [
            {
              span: null,
              code: "ai_check_skipped",
              reason:
                "The AI safety check could not run — only the deterministic checks were applied.",
              level: "info",
            },
          ],
        },
      };
    });

    const user = userEvent.setup();
    await user.type(body(), text);

    await waitFor(() => {
      expect(screen.getByTestId("degraded-notice").textContent).toContain(
        "Automated check unavailable — deterministic checks only",
      );
    });
    // Degraded mode never blocks a clean draft.
    expect(submitButton().disabled).toBe(false);
  });

  it("discards stale server findings once the user keeps typing", async () => {
    // The server (slow) answers for an OLD text with a block finding; the
    // hash mismatch must keep it from painting over the current text.
    setup({}, (fields) => {
      if (fields.intent !== "safety-check") return {};
      return {
        safety: {
          level: "block",
          checkedHash: textHash("something else entirely"),
          findings: [
            {
              span: { start: 0, end: 4 },
              code: "appointment_detail",
              reason: "Stale finding from previous text.",
              level: "block",
            },
          ],
        },
      };
    });

    const user = userEvent.setup();
    await user.type(body(), "A clean reply.");
    // Give the debounce + fetcher a beat, then confirm the stale block
    // never applied: submit stays enabled, no findings listed.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(submitButton().disabled).toBe(false);
    expect(screen.queryByTestId("safety-findings")).toBeNull();
  });

  it("Draft with AI fills the textarea as an editable draft with the review note", async () => {
    const drafted = "Thank you for the kind words — comfort matters to us.";
    setup({}, (fields) => {
      if (fields.intent === "draft-with-ai") {
        return {
          draft: drafted,
          safety: { level: "ok", checkedHash: textHash(drafted), findings: [] },
        };
      }
      return {};
    });

    const user = userEvent.setup();
    await user.click(screen.getByTestId("draft-with-ai"));

    await waitFor(() => {
      expect(body().value).toBe(drafted);
    });
    // Editable, never auto-submitted; the note stays until a human edit.
    expect(screen.getByTestId("ai-note").textContent).toContain(
      "AI draft — review before sending",
    );
    expect(submitButton().disabled).toBe(false);

    await user.type(body(), " Truly.");
    expect(screen.queryByTestId("ai-note")).toBeNull();
  });

  it("shows the friendly paused message when AI drafting is unavailable", async () => {
    setup({}, (fields) =>
      fields.intent === "draft-with-ai"
        ? {
            aiUnavailable:
              "AI drafting is paused — you can still write a reply.",
          }
        : {},
    );

    const user = userEvent.setup();
    await user.click(screen.getByTestId("draft-with-ai"));

    await waitFor(() => {
      expect(screen.getByTestId("ai-unavailable").textContent).toContain(
        "AI drafting is paused",
      );
    });
    expect(body().disabled).toBe(false);
  });

  it("inserts a template with placeholders interpolated (anonymous reviewer)", async () => {
    const user = userEvent.setup();
    setup();

    await user.selectOptions(
      screen.getByTestId("template-picker"),
      TEMPLATES[0]?.id ?? "",
    );
    await user.click(screen.getByTestId("insert-template"));

    // No overwrite confirm for an empty draft; {practice_name} filled,
    // {reviewer_name} removed cleanly along with its vocative comma.
    expect(screen.queryByTestId("overwrite-confirm")).toBeNull();
    expect(body().value).toBe(
      "Thank you so much for the kind words. It means a lot to us at Cedar Ridge Dental.",
    );
  });

  it("asks before overwriting a non-empty draft, and keeps it on cancel", async () => {
    const user = userEvent.setup();
    setup();

    await user.type(body(), "Hand-written start.");
    await user.selectOptions(
      screen.getByTestId("template-picker"),
      TEMPLATES[0]?.id ?? "",
    );
    await user.click(screen.getByTestId("insert-template"));

    const confirm = screen.getByTestId("overwrite-confirm");
    expect(confirm.textContent).toContain("Replace the current draft");
    await user.click(screen.getByText("Keep my draft"));
    expect(body().value).toBe("Hand-written start.");

    // Asking again and confirming replaces the draft.
    await user.click(screen.getByTestId("insert-template"));
    await user.click(screen.getByTestId("overwrite-confirm-yes"));
    expect(body().value).toContain("Thank you so much for the kind words.");
  });

  it("counts characters and bytes, and hard-stops past the GBP byte cap", async () => {
    const user = userEvent.setup();
    setup({
      draft: {
        id: RESPONSE_ID,
        body: "€".repeat(1400),
        rejectionComment: null,
      },
    });

    // 1400 × 3 bytes = 4200 > 4096: red count, disabled submit, plain why.
    expect(screen.getByTestId("char-count").textContent).toContain(
      "1400 characters",
    );
    expect(screen.getByTestId("char-count").textContent).toContain("4200/4096");
    expect(submitButton().disabled).toBe(true);
    expect(screen.getByText(/Google caps replies/).textContent).toContain(
      "4096",
    );

    await user.clear(body());
    await user.type(body(), "Short and safe.");
    expect(submitButton().disabled).toBe(false);
  });

  it("adopts the row a bounced submit created — the retry updates, never duplicates", async () => {
    const posts: Array<Record<string, string>> = [];
    setup({}, (fields) => {
      posts.push(fields);
      if (fields.intent === "submit-for-approval") {
        return {
          saved: { responseId: RESPONSE_ID, body: fields.body ?? "" },
          safety: {
            level: "warn",
            checkedHash: textHash(fields.body ?? ""),
            findings: [
              {
                span: null,
                code: "phi_identifier",
                reason: "Contains a phone number.",
                level: "warn",
              },
            ],
          },
        };
      }
      return {};
    });

    const user = userEvent.setup();
    await user.type(body(), "Call us at 555-201-4400 anytime.");
    await user.click(screen.getByTestId("acknowledge-warnings"));
    await user.click(submitButton());

    await waitFor(() => {
      const submit = posts.find(
        (fields) => fields.intent === "submit-for-approval",
      );
      expect(submit).toBeDefined();
    });

    // The bounce carried the created row's id; the next mutation posts it.
    await user.click(screen.getByTestId("acknowledge-warnings"));
    await user.click(screen.getByTestId("acknowledge-warnings"));
    await user.click(submitButton());
    await waitFor(() => {
      const submits = posts.filter(
        (fields) => fields.intent === "submit-for-approval",
      );
      expect(submits.length).toBeGreaterThanOrEqual(2);
      expect(submits[submits.length - 1]?.responseId).toBe(RESPONSE_ID);
    });
  });

  it("restores a persisted draft and its changes-requested comment", () => {
    setup({
      draft: {
        id: RESPONSE_ID,
        body: "The saved draft text.",
        rejectionComment: "Please soften the tone.",
      },
    });
    expect(body().value).toBe("The saved draft text.");
    expect(screen.getByTestId("rejection-comment").textContent).toContain(
      "Please soften the tone.",
    );
  });
});
