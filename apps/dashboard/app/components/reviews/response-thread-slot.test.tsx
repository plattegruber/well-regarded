// ResponseThreadSlot (#77): the honest empty state, the newest-first
// history rendering, and the composer seam #79 mounts into.
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  type ResponseThreadEntryView,
  ResponseThreadSlot,
} from "./response-thread-slot";

function entry(
  overrides: Partial<ResponseThreadEntryView> = {},
): ResponseThreadEntryView {
  return {
    id: "r1",
    status: "responded",
    body: "Thank you for taking the time to share this.",
    authorName: "Dana Whitfield",
    createdOn: "July 2, 2026",
    publishedOn: "July 3, 2026",
    publishedUrl: "https://maps.google.com/reply/1",
    ...overrides,
  };
}

describe("ResponseThreadSlot", () => {
  it("renders the honest empty state when no response is recorded", () => {
    const html = renderToString(<ResponseThreadSlot entries={[]} />);
    expect(html).toContain('data-testid="response-thread"');
    expect(html).toContain("No response recorded yet");
    expect(html).not.toContain('data-testid="response-entry"');
  });

  it("renders entries with status chip, author, body, and publish link", () => {
    const html = renderToString(
      <ResponseThreadSlot
        entries={[
          entry(),
          entry({
            id: "r2",
            status: "drafted",
            publishedOn: null,
            publishedUrl: null,
          }),
        ]}
      />,
    );
    expect(html).toContain("Responded");
    expect(html).toContain("Drafted");
    expect(html).toContain("Dana Whitfield");
    expect(html).toContain("taking the time to share");
    // SSR inserts comment nodes between text segments; assert the pieces.
    expect(html).toContain("Published ");
    expect(html).toContain("July 3, 2026");
    expect(html).toContain("https://maps.google.com/reply/1");
  });

  it("renders the source-honesty note when given", () => {
    const html = renderToString(
      <ResponseThreadSlot
        entries={[]}
        sourceNote="Replies posted directly on Google are not captured yet."
      />,
    );
    expect(html).toContain("not captured yet");
  });

  it("mounts the composer slot below the history (#79's seam)", () => {
    const html = renderToString(
      <ResponseThreadSlot
        entries={[]}
        composer={<div data-testid="composer-slot">composer goes here</div>}
      />,
    );
    expect(html).toContain('data-testid="composer-slot"');
    expect(html).toContain("composer goes here");
  });
});
