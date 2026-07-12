/**
 * Golden-set fixture shapes and loading (issue #73).
 *
 * One zod schema per fixture file so a malformed line fails loudly at
 * load time (and in evals/fixtures.test.ts) instead of producing a
 * nonsense score. The shapes mirror what #67/#69/#72 committed — see
 * evals/README.md for the field-by-field contract.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PUBLICATION_SUITABILITIES,
  RESPONSE_RISKS,
  SENTIMENTS,
  URGENCY_LEVELS,
} from "@wellregarded/core";
import { z } from "zod";

const EVALS_DIR = dirname(fileURLToPath(import.meta.url));

export const FIXTURES_DIR = join(EVALS_DIR, "fixtures");
export const REPORTS_DIR = join(EVALS_DIR, "reports");
export const THRESHOLDS_PATH = join(EVALS_DIR, "thresholds.json");

/** Inclusive [low, high] confidence band. */
const band = z
  .tuple([z.number().min(0).max(1), z.number().min(0).max(1)])
  .refine(([low, high]) => low <= high, "band low must be <= high");

const ratingSchema = z.union([z.string(), z.number()]).nullable();

export const JudgmentsFixtureSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  input: z.object({
    text: z.string().nullable(),
    rating: ratingSchema,
  }),
  expected: z.object({
    sentiment: z.enum(SENTIMENTS),
    urgency: z.enum(URGENCY_LEVELS),
    response_risk: z.enum(RESPONSE_RISKS),
    publication_suitability: z.enum(PUBLICATION_SUITABILITIES),
    confidence_band: z
      .union([
        band,
        z
          .object({
            sentiment: band.optional(),
            urgency: band.optional(),
            response_risk: band.optional(),
            publication_suitability: band.optional(),
          })
          .strict(),
      ])
      .optional(),
  }),
  notes: z.string().min(1),
});

export type JudgmentsFixture = z.infer<typeof JudgmentsFixtureSchema>;

export const ExcerptsFixtureSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  input: z.object({
    text: z.string().min(1),
    rating: ratingSchema.optional(),
  }),
  expected: z.object({
    excerpts: z
      .array(
        z.object({
          text: z.string().min(1),
          start_offset: z.number().int().min(0),
          topic_hint: z.string().min(1),
        }),
      )
      .min(1),
  }),
  notes: z.string().min(1),
});

export type ExcerptsFixture = z.infer<typeof ExcerptsFixtureSchema>;

export const SafetyFixtureSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  input: z.object({
    draft: z.string().min(1),
    review: z.object({
      text: z.string().nullable(),
      rating: ratingSchema,
      visibility: z.enum(["public", "private"]),
    }),
  }),
  expected: z.object({
    level: z.enum(["ok", "warn", "block"]),
    must_block: z.boolean().optional(),
  }),
  notes: z.string().min(1),
});

export type SafetyFixture = z.infer<typeof SafetyFixtureSchema>;

/** Parse one JSONL file, validating every line and requiring unique ids. */
export function loadJsonl<T extends { id: string }>(
  path: string,
  schema: z.ZodType<T>,
): T[] {
  const rows = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const parsed = schema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        throw new Error(
          `${path}:${index + 1} does not match the fixture schema: ${parsed.error.message}`,
        );
      }
      return parsed.data;
    });
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) {
      throw new Error(`${path}: duplicate fixture id "${row.id}"`);
    }
    ids.add(row.id);
  }
  return rows;
}

export function loadJudgmentsFixtures(
  dir: string = FIXTURES_DIR,
): JudgmentsFixture[] {
  return loadJsonl(join(dir, "judgments.jsonl"), JudgmentsFixtureSchema);
}

export function loadExcerptsFixtures(
  dir: string = FIXTURES_DIR,
): ExcerptsFixture[] {
  return loadJsonl(join(dir, "excerpts.jsonl"), ExcerptsFixtureSchema);
}

export function loadSafetyFixtures(
  dir: string = FIXTURES_DIR,
): SafetyFixture[] {
  return loadJsonl(join(dir, "safety.jsonl"), SafetyFixtureSchema);
}
