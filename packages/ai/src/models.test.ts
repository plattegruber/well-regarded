import { describe, expect, it } from "vitest";

import { resolveModel } from "./models.js";

const config = {
  pipeline: "claude-haiku-4-5-20251001",
  drafting: "claude-sonnet-5",
};

describe("resolveModel", () => {
  it("routes the pipeline lane to the pipeline model id", () => {
    expect(resolveModel("pipeline", config)).toBe("claude-haiku-4-5-20251001");
  });

  it("routes the drafting lane to the drafting model id", () => {
    expect(resolveModel("drafting", config)).toBe("claude-sonnet-5");
  });
});
