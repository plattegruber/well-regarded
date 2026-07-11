/**
 * Writes the recorded-shape GBP fixtures to `src/google/fixtures/*.json`
 * (issue #130, requirement 5).
 *
 *     pnpm --filter @wellregarded/sources gen:google-fixtures
 *
 * Output is deterministic (seed 42, clock pinned) — running this twice
 * yields byte-identical files. `src/google/fake/fixtureFiles.test.ts` fails
 * whenever the checked-in files no longer match what the fake server
 * serves; this script is the fix.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderGoogleFixtureFiles } from "../src/google/fake/fixtureFiles.js";

const outDir = fileURLToPath(
  new URL("../src/google/fixtures/", import.meta.url),
);

const files = await renderGoogleFixtureFiles();
await mkdir(outDir, { recursive: true });
for (const [name, content] of Object.entries(files)) {
  await writeFile(join(outDir, name), content);
  console.log(`wrote src/google/fixtures/${name}`);
}
