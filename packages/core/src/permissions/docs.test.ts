import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { renderPermissionsDoc } from "./docs";

const COMMITTED_DOC = fileURLToPath(
  new URL("../../../../docs/permissions.md", import.meta.url),
);

describe("docs/permissions.md", () => {
  it("matches the matrix data — run `pnpm gen:docs` if this fails", () => {
    const committed = readFileSync(COMMITTED_DOC, "utf8");
    expect(committed).toBe(renderPermissionsDoc());
  });
});
