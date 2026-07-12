/**
 * `pnpm eval` — the live eval CLI (issue #73).
 *
 *   pnpm eval [judgments|excerpts|safety|all] [--only <id>]... [--limit N]
 *
 * Runs the golden sets against the LIVE Anthropic API through the real
 * `AnthropicProvider` (which also exercises its retry/validation paths in
 * anger), scores them (evals/score.ts), writes a markdown report per set
 * to evals/reports/<set>-<date>-<model>.md, and exits non-zero when any
 * set regresses past evals/thresholds.json.
 *
 * `ANTHROPIC_API_KEY` is REQUIRED: without it the run refuses loudly
 * rather than faking anything (exit 2). `--only`/`--limit` make iterating
 * on one failing case cheap; partial runs are stamped as partial in the
 * report and must not be committed as baselines.
 *
 * Run from the repo root as `pnpm eval` (which builds workspace deps
 * first — the prompts import @wellregarded/core's dist build), or from
 * packages/ai as `pnpm eval` after a `pnpm --filter "@wellregarded/ai^..." build`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exit } from "node:process";
import { parseArgs } from "node:util";

import { AnthropicProvider } from "../src/anthropic.js";
import {
  loadExcerptsFixtures,
  loadJudgmentsFixtures,
  loadSafetyFixtures,
  REPORTS_DIR,
  THRESHOLDS_PATH,
} from "./cases.js";
import {
  EVAL_SETS,
  type EvalSet,
  type RunOptions,
  runEvalSet,
} from "./runner.js";
import type { Thresholds } from "./score.js";

// Defaults mirror the `ai` env fragment in packages/core/src/env.ts — the
// eval CLI runs outside a Worker, so it reads process.env directly.
const DEFAULT_PIPELINE_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_DRAFTING_MODEL = "claude-sonnet-5";

function usageAndExit(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    "Usage: pnpm eval [judgments|excerpts|safety|all] [--only <id>]... [--limit N]",
  );
  exit(2);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      only: { type: "string", multiple: true },
      limit: { type: "string" },
    },
    allowPositionals: true,
  });

  const requested = positionals[0] ?? "all";
  if (positionals.length > 1) usageAndExit("pass at most one set name");
  const sets: EvalSet[] =
    requested === "all"
      ? [...EVAL_SETS]
      : EVAL_SETS.includes(requested as EvalSet)
        ? [requested as EvalSet]
        : usageAndExit(`unknown set "${requested}"`);

  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      usageAndExit(`--limit must be a positive integer, got "${values.limit}"`);
    }
  }
  const options: RunOptions = {
    only: values.only?.flatMap((entry) => entry.split(",")),
    limit,
  };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      "error: ANTHROPIC_API_KEY is not set.\n\n" +
        "The eval harness scores prompts against the LIVE model — there is\n" +
        "no fake mode by design (FakeAiProvider would only measure itself).\n" +
        "Export an API key and re-run:\n\n" +
        "  ANTHROPIC_API_KEY=sk-ant-... pnpm eval\n",
    );
    exit(2);
  }

  const provider = new AnthropicProvider({
    apiKey,
    models: {
      pipeline: process.env.PIPELINE_MODEL ?? DEFAULT_PIPELINE_MODEL,
      drafting: process.env.DRAFTING_MODEL ?? DEFAULT_DRAFTING_MODEL,
    },
  });

  const thresholds = JSON.parse(
    readFileSync(THRESHOLDS_PATH, "utf8"),
  ) as Thresholds;
  const fixtures = {
    judgments: loadJudgmentsFixtures(),
    excerpts: loadExcerptsFixtures(),
    safety: loadSafetyFixtures(),
  };
  const date = new Date().toISOString().slice(0, 10);

  mkdirSync(REPORTS_DIR, { recursive: true });

  let failed = false;
  for (const set of sets) {
    console.log(`\n=== ${set} ===`);
    const outcome = await runEvalSet({
      set,
      provider,
      options,
      thresholds,
      date,
      fixtures,
    });
    const reportPath = join(REPORTS_DIR, outcome.reportFilename);
    writeFileSync(reportPath, outcome.report);
    console.log(outcome.report);
    console.log(`report written to ${reportPath}`);
    if (!outcome.verdict.passed) {
      failed = true;
      console.error(`\n${set}: FAIL`);
      for (const failure of outcome.verdict.failures) {
        console.error(`  - ${failure}`);
      }
    } else {
      console.log(`${set}: PASS`);
    }
  }

  if (failed) {
    console.error("\nEval run FAILED — one or more thresholds regressed.");
    exit(1);
  }
  console.log("\nEval run passed.");
}

main().catch((error) => {
  console.error(error);
  exit(1);
});
