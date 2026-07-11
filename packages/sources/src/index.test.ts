import { describe, expect, it } from "vitest";

import { PACKAGE_NAME } from "./index";

describe("@wellregarded/sources", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@wellregarded/sources");
  });
});
