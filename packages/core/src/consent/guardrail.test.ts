/**
 * Enforcement guardrail (issue #84 requirement 6, Epic #12): there is no
 * `is_publishable` boolean anywhere in the system — publication eligibility
 * is always computed from `consents` rows via `checkConsent`. This
 * meta-test fails CI (the unit `test` job) if the forbidden string appears
 * in `apps/`, `workers/`, or `packages/`, so a cached publishability flag
 * cannot land: a column, variable, or payload field named after it is
 * exactly the bug CONSENT.md forbids.
 *
 * Two sanctioned ways to mention the string:
 * - inside backticks — prose in docs and comments talks *about* the rule
 *   ("there is no `…` boolean"), and code never wears backticks;
 * - a line carrying the `consent-guard: allow` marker — for tests that
 *   assert the string's absence and need the literal.
 *
 * See the "Publication checks" section of CONTRIBUTING.md.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Built dynamically so this file never contains the literal it forbids.
const FORBIDDEN = ["is", "publishable"].join("_");
const ALLOW_MARKER = "consent-guard: allow";

const SCANNED_DIRS = ["apps", "workers", "packages"];
const SCANNED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".sql",
  ".json",
  ".md",
  ".mdx",
  ".yml",
  ".yaml",
]);
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".wrangler",
  ".git",
  ".next",
]);

/** Violating lines of one file's text: un-backticked, un-marked mentions. */
function forbiddenLines(text: string): number[] {
  if (!text.includes(FORBIDDEN)) return [];
  const violations: number[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.includes(ALLOW_MARKER)) continue;
    // Prose mentions the string in backticks; code never does.
    const withoutInlineCode = line.replace(/`[^`]*`/g, "");
    if (withoutInlineCode.includes(FORBIDDEN)) violations.push(index + 1);
  }
  return violations;
}

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
  return dir;
}

function* scannedFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* scannedFiles(full);
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

describe("publication-flag guardrail", () => {
  it(`the string "${FORBIDDEN}" appears nowhere in apps/, workers/, or packages/`, () => {
    const root = repoRoot();
    const violations: string[] = [];
    for (const base of SCANNED_DIRS) {
      const baseDir = path.join(root, base);
      if (!existsSync(baseDir)) continue;
      for (const file of scannedFiles(baseDir)) {
        for (const line of forbiddenLines(readFileSync(file, "utf8"))) {
          violations.push(`${path.relative(root, file)}:${line}`);
        }
      }
    }
    expect(
      violations,
      `"${FORBIDDEN}" found — publication eligibility is computed from consents rows via checkConsent, never cached in a flag (see CONTRIBUTING.md "Publication checks")`,
    ).toEqual([]);
  });

  it("flags a bare mention", () => {
    expect(forbiddenLines(`const ${FORBIDDEN} = true;`)).toEqual([1]);
    expect(
      forbiddenLines(`ALTER TABLE x ADD COLUMN ${FORBIDDEN} bool;`),
    ).toEqual([1]);
    expect(forbiddenLines(`"${FORBIDDEN}": { "type": "boolean" }`)).toEqual([
      1,
    ]);
  });

  it("permits backticked prose and marked assertion lines", () => {
    expect(forbiddenLines(`* There is no \`${FORBIDDEN}\` boolean.`)).toEqual(
      [],
    );
    expect(
      forbiddenLines(
        `expect(cols).not.toContain("${FORBIDDEN}"); // ${ALLOW_MARKER}`,
      ),
    ).toEqual([]);
  });

  it("reports the exact line numbers", () => {
    expect(forbiddenLines(`ok\n${FORBIDDEN}\nok\nlet ${FORBIDDEN};`)).toEqual([
      2, 4,
    ]);
  });
});
