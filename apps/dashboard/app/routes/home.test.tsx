import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Home, { meta } from "./home";

describe("home route", () => {
  it("renders the app name", () => {
    const html = renderToString(<Home />);
    expect(html).toContain("Well Regarded");
  });

  it("titles the document", () => {
    expect(meta()).toContainEqual({ title: "Well Regarded" });
  });
});
