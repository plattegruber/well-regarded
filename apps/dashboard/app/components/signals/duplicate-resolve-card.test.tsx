// The duplicate resolve affordance (#90): side-by-side previews and the
// same/different actions — hidden entirely for viewers who lack the
// resolve_duplicates permission (never rendered disabled).
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import {
  type DuplicateCardData,
  type DuplicatePreview,
  DuplicateResolveCard,
} from "./duplicate-resolve-card";

const current: DuplicatePreview = {
  sourceLabel: "Google",
  occurredOn: "July 4, 2026",
  text: "Charged for a service I was told insurance would cover.",
  rating: 2,
};

const duplicate: DuplicateCardData = {
  id: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
  similarityLabel: "96% text similarity",
  other: {
    signalId: "7f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    sourceLabel: "Email",
    occurredOn: "July 5, 2026",
    text: "I do not understand the insurance adjustment on my statement.",
    rating: null,
  },
};

function render(canResolve: boolean): string {
  const Stub = createRoutesStub([
    {
      path: "/signals/abc",
      Component: () => (
        <DuplicateResolveCard
          duplicate={duplicate}
          current={current}
          canResolve={canResolve}
        />
      ),
    },
  ]);
  return renderToString(<Stub initialEntries={["/signals/abc"]} />);
}

describe("DuplicateResolveCard", () => {
  it("shows both texts side by side with their sources and dates", () => {
    const html = render(true);
    expect(html).toContain("This signal · Google");
    expect(html).toContain("Candidate · Email");
    expect(html).toContain("insurance would cover");
    expect(html).toContain("insurance adjustment");
    expect(html).toContain("96% text similarity");
    expect(html).toContain("Both records are kept either way.");
  });

  it("renders the resolve actions for permitted viewers", () => {
    const html = render(true);
    expect(html).toContain("Same event");
    expect(html).toContain("Different");
    expect(html).toContain('name="duplicateId"');
    expect(html).toContain(duplicate.id);
    expect(html).toContain('value="resolve-duplicate"');
  });

  it("hides the actions — not disables them — without the permission", () => {
    const html = render(false);
    expect(html).not.toContain("Same event");
    expect(html).not.toContain("<button");
    // The evidence still renders read-only.
    expect(html).toContain("insurance adjustment");
  });
});
