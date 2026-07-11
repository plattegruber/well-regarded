import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RatingStars } from "./rating-stars";

describe("RatingStars", () => {
  it("labels the star row for assistive tech", () => {
    const html = renderToString(<RatingStars rating={4.8} />);
    expect(html).toContain('aria-label="4.8 of 5 stars"');
    expect(html).toContain('role="img"');
  });

  it("renders max stars, green filled on gray-300 empty", () => {
    const html = renderToString(<RatingStars rating={3} max={5} />);
    expect(html.match(/<svg/g)).toHaveLength(5);
    expect(html).toContain("var(--accent-star)");
    expect(html).toContain("var(--gray-300)");
  });

  it("clips the partial star", () => {
    const html = renderToString(<RatingStars rating={4.5} />);
    expect(html).toContain("inset(0 50% 0 0)");
  });

  it("shows the value in tabular figures when asked", () => {
    const html = renderToString(<RatingStars rating={5} showValue />);
    expect(html).toContain("5.0");
    expect(html).toContain("tabular-nums");
    expect(renderToString(<RatingStars rating={5} />)).not.toContain("5.0");
  });
});
