/**
 * Writes `docs/permissions.md` (repo root) from the permission matrix data.
 * Run via `pnpm gen:docs`. A unit test (`src/permissions/docs.test.ts`)
 * asserts the committed file matches, so a stale doc fails CI.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderPermissionsDoc } from "../src/permissions/docs";

const target = fileURLToPath(
  new URL("../../../docs/permissions.md", import.meta.url),
);

writeFileSync(target, renderPermissionsDoc());
console.log(`Wrote ${target}`);
