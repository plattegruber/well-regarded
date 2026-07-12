// The shared basis badge (#88/#90): ethical invariant #1 in component form
// — an inference is never presented as confirmed fact.
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BasisBadge, JudgmentChip } from "./basis-badge";

describe("BasisBadge", () => {
  it("renders inferred bases dashed, with plain-language confidence", () => {
    const html = renderToString(
      <BasisBadge basis="inferred_text" confidence={0.82} />,
    );
    expect(html).toContain("Inferred from text");
    expect(html).toContain("moderate confidence");
    expect(html).toContain("border-dashed");
    expect(html).toContain('data-basis="inferred_text"');
  });

  it("renders manual as staff confirmed, solid — never as 'confidence' (#93)", () => {
    const html = renderToString(<BasisBadge basis="manual" confidence={1} />);
    expect(html).toContain("Staff confirmed");
    // Confidence is model language; a human assertion is just confirmed.
    expect(html).not.toContain("high confidence");
    expect(html).not.toContain("border-dashed");
  });

  it("renders source metadata with its own label", () => {
    const html = renderToString(<BasisBadge basis="source_metadata" />);
    expect(html).toContain("From source data");
    // Confidence omitted → no separator dangling.
    expect(html).not.toContain("·");
  });

  it("maps confidence bands to plain language", () => {
    expect(
      renderToString(<BasisBadge basis="inferred_text" confidence={0.95} />),
    ).toContain("high confidence");
    expect(
      renderToString(<BasisBadge basis="inferred_text" confidence={0.5} />),
    ).toContain("low confidence");
  });
});

describe("JudgmentChip", () => {
  it("marks inferred judgments with the mockup's suffix", () => {
    const html = renderToString(
      <JudgmentChip label="High urgency" basis="inferred_related" />,
    );
    expect(html).toContain("High urgency");
    expect(html).toContain("· inferred");
  });

  it("renders confirmed facts without the suffix", () => {
    const html = renderToString(<JudgmentChip label="North" />);
    expect(html).toContain("North");
    expect(html).not.toContain("inferred");
  });
});
