import { describe, expect, it } from "vitest";

import { CORE_DEPENDENCY, PACKAGE_NAME } from "./index";

describe("@wellregarded/api", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@wellregarded/api");
  });

  it("imports a constant from @wellregarded/core via workspace:*", () => {
    expect(CORE_DEPENDENCY).toBe("@wellregarded/core");
  });
});
